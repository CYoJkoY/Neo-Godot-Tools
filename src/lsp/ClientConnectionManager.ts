import * as vscode from "vscode";

import {
	createLogger,
	get_configuration,
	get_free_port,
	get_project_dir,
	get_project_version,
	register_command,
	set_configuration,
	set_context,
	verify_godot_version,
} from "../utils";
import { prompt_for_godot_executable, prompt_for_reload, select_godot_executable } from "../utils/prompts";
import { killSubProcesses, subProcess } from "../utils/subspawn";
import GDScriptLanguageClient, { ClientStatus, TargetLSP } from "./GDScriptLanguageClient";
import { EventEmitter } from "vscode";

const log = createLogger("lsp.manager", { output: "Godot LSP" });

export enum ManagerStatus {
	INITIALIZING = 0,
	INITIALIZING_LSP = 1,
	PENDING = 2,
	PENDING_LSP = 3,
	DISCONNECTED = 4,
	CONNECTED = 5,
	RETRYING = 6,
	WRONG_WORKSPACE = 7,
}

export class ClientConnectionManager implements vscode.Disposable {
	public client: GDScriptLanguageClient;

	private statusChanged = new EventEmitter<ManagerStatus>();
	onStatusChanged = this.statusChanged.event;

	private reconnectionAttempts = 0;
	private reconnectTimer?: ReturnType<typeof setInterval>;
	private lifecycleGeneration = 0;
	private clientGeneration = 0;
	private disposed = false;

	private target: TargetLSP = TargetLSP.EDITOR;
	private status: ManagerStatus = ManagerStatus.INITIALIZING;
	private statusWidget: vscode.StatusBarItem;

	private connectedVersion = "";

	constructor(private context: vscode.ExtensionContext) {
		this.create_new_client();

		this.reconnectTimer = setInterval(() => {
			this.retry_callback();
		}, get_configuration("lsp.autoReconnect.cooldown"));

		set_context("connectedToLSP", false);

		this.statusWidget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
		this.statusWidget.command = "neoGodotTools.checkStatus";
		this.statusWidget.show();
		this.update_status_widget();

		context.subscriptions.push(
			register_command("startLanguageServer", () => {
				void this.start_headless_and_connect();
			}),
			register_command("stopLanguageServer", this.stop_language_server.bind(this)),
			register_command("checkStatus", this.on_status_item_click.bind(this)),
			this.statusWidget,
		);

		void this.connect_to_language_server();
	}

	dispose(): void {
		this.disposed = true;
		this.lifecycleGeneration++;
		this.clientGeneration++;
		if (this.reconnectTimer) clearInterval(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.stop_language_server();
		this.client?.io?.removeAllListeners();
		this.client?.events?.removeAllListeners();
		void this.client?.stop();
		this.statusChanged.dispose();
	}

	private create_new_client() {
		const port = this.client?.port ?? -1;
		this.client?.io?.removeAllListeners();
		this.client?.events?.removeAllListeners();
		void this.client?.stop();

		const clientGeneration = ++this.clientGeneration;
		const client = new GDScriptLanguageClient();
		client.port = port;
		client.events.on("status", (status) => {
			if (this.disposed || clientGeneration !== this.clientGeneration) return;
			this.on_client_status_changed(status);
		});
		this.client = client;
	}

	private async start_headless_and_connect(): Promise<void> {
		this.reconnectionAttempts = 0;
		this.target = TargetLSP.HEADLESS;
		const generation = ++this.lifecycleGeneration;
		await this.start_language_server(generation);
		if (this.disposed || generation !== this.lifecycleGeneration) return;
		this.client.connect(this.target);
	}

	private async connect_to_language_server() {
		const generation = ++this.lifecycleGeneration;
		this.client.port = -1;
		this.target = TargetLSP.EDITOR;
		this.connectedVersion = "";

		if (get_configuration("lsp.headless")) {
			this.target = TargetLSP.HEADLESS;
			await this.start_language_server(generation);
			if (this.disposed || generation !== this.lifecycleGeneration) return;
		}

		this.reconnectionAttempts = 0;
		if (!this.disposed && generation === this.lifecycleGeneration) this.client.connect(this.target);
	}

	private stop_language_server() {
		killSubProcesses("LSP");
	}

	private async start_language_server(generation: number) {
		this.stop_language_server();

		const projectDir = await get_project_dir();
		if (this.disposed || generation !== this.lifecycleGeneration) return;
		if (!projectDir) {
			vscode.window.showErrorMessage("Current workspace is not a Godot project");
			return;
		}

		const projectVersion = await get_project_version();
		if (this.disposed || generation !== this.lifecycleGeneration) return;
		let minimumVersion = "6";
		let targetVersion = "3.6";
		if (projectVersion?.startsWith("4")) {
			minimumVersion = "2";
			targetVersion = "4.2";
		}
		const settingName = `editorPath.godot${projectVersion?.[0] || ""}`;
		let godotPath = get_configuration(settingName);

		const result = verify_godot_version(godotPath, projectVersion?.[0] || "");
		godotPath = result.godotPath;

		switch (result.status) {
			case "WRONG_VERSION": {
				const message = `Cannot launch headless LSP: The current project uses Godot v${projectVersion}, but the specified Godot executable is v${result.version}`;
				prompt_for_godot_executable(message, settingName);
				return;
			}
			case "INVALID_EXE": {
				const message = `Cannot launch headless LSP: '${godotPath}' is not a valid Godot executable`;
				prompt_for_godot_executable(message, settingName);
				return;
			}
		}
		this.connectedVersion = result.version || "";

		if (result.version && result.version[2] < minimumVersion) {
			const message = `Cannot launch headless LSP: Headless LSP mode is only available on v${targetVersion} or newer, but the specified Godot executable is v${result.version}.`;
			vscode.window
				.showErrorMessage(message, "Select Godot executable", "Open Settings", "Disable Headless LSP", "Ignore")
				.then((item) => {
					if (item === "Select Godot executable") select_godot_executable(settingName);
					else if (item === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", settingName);
					else if (item === "Disable Headless LSP") {
						set_configuration("lsp.headless", false);
						prompt_for_reload();
					}
				});
			return;
		}

		const port = await get_free_port();
		if (this.disposed || generation !== this.lifecycleGeneration) return;
		this.client.port = port;

		log.info(`starting headless LSP on port ${this.client.port}`);

		const headlessFlags = "--headless --no-window";
		const command = `"${godotPath}" --path "${projectDir}" --editor ${headlessFlags} --lsp-port ${this.client.port}`;
		const lspProcess = subProcess("LSP", command, { shell: true, detached: true });

		const lspStdout = createLogger("lsp.stdout");
		lspProcess.stdout.on("data", (data) => {
			const out = data.toString().trim();
			if (out) lspStdout.debug(out);
		});

		lspProcess.stderr.on("data", () => {});
		lspProcess.on("close", (code) => log.info(`LSP process exited with code ${code}`));
	}

	private get_lsp_connection_string() {
		const host = get_configuration("lsp.serverHost");
		let port = get_configuration("lsp.serverPort");
		if (this.client.port !== -1) port = this.client.port;
		return `${host}:${port}`;
	}

	private on_status_item_click() {
		const lspTarget = this.get_lsp_connection_string();
		switch (this.status) {
			case ManagerStatus.CONNECTED: {
				const message = `Connected to the GDScript language server at ${lspTarget}.`;
				const options = this.target === TargetLSP.HEADLESS ? ["Restart LSP", "Ok"] : ["Ok"];
				void vscode.window.showInformationMessage(message, ...options).then((item) => {
					if (item === "Restart LSP") void this.connect_to_language_server();
				});
				break;
			}
			case ManagerStatus.DISCONNECTED:
				this.retry_connect_client();
				break;
			case ManagerStatus.RETRYING:
				this.show_retrying_prompt();
				break;
			case ManagerStatus.WRONG_WORKSPACE:
				this.retry_connect_client();
				break;
			default:
				break;
		}
	}

	private update_status_widget() {
		const lspTarget = this.get_lsp_connection_string();
		const maxAttempts = get_configuration("lsp.autoReconnect.attempts");
		let text = "";
		let tooltip = "";
		switch (this.status) {
			case ManagerStatus.INITIALIZING:
				text = "$(sync~spin) Initializing";
				tooltip = "Initializing extension...";
				break;
			case ManagerStatus.INITIALIZING_LSP:
				text = `$(sync~spin) Initializing LSP ${this.reconnectionAttempts}/${maxAttempts}`;
				tooltip = `Connecting to headless GDScript language server.\n${lspTarget}`;
				if (this.connectedVersion) tooltip += `\n${this.connectedVersion}`;
				break;
			case ManagerStatus.PENDING:
				text = "$(sync~spin) Connecting";
				tooltip = `Connecting to the GDScript language server at ${lspTarget}`;
				break;
			case ManagerStatus.CONNECTED:
				text = "$(check) Connected";
				tooltip = `Connected to the GDScript language server.\n${lspTarget}`;
				if (this.connectedVersion) tooltip += `\nGodot version: ${this.connectedVersion}`;
				break;
			case ManagerStatus.DISCONNECTED:
				text = "$(x) Disconnected";
				tooltip = "Disconnected from the GDScript language server.";
				break;
			case ManagerStatus.RETRYING:
				text = `$(sync~spin) Connecting ${this.reconnectionAttempts}/${maxAttempts}`;
				tooltip = `Connecting to the GDScript language server.\n${lspTarget}`;
				if (this.connectedVersion) tooltip += `\n${this.connectedVersion}`;
				break;
			case ManagerStatus.WRONG_WORKSPACE:
				text = "$(x) Wrong Project";
				tooltip = "Disconnected from the GDScript language server.";
				break;
		}
		this.statusWidget.text = text;
		this.statusWidget.tooltip = tooltip;
	}

	private on_client_status_changed(status: ClientStatus) {
		if (this.disposed) return;
		switch (status) {
			case ClientStatus.PENDING:
				this.status = ManagerStatus.PENDING;
				break;
			case ClientStatus.CONNECTED:
				this.retry = false;
				this.reconnectionAttempts = 0;
				set_context("connectedToLSP", true);
				this.status = ManagerStatus.CONNECTED;
				if (this.client.needsStart()) void this.client.start().then(() => log.info("LSP Client started"));
				break;
			case ClientStatus.DISCONNECTED:
				this.create_new_client();
				if (this.retry) this.status = this.client.port !== -1 ? ManagerStatus.INITIALIZING_LSP : ManagerStatus.RETRYING;
				else this.status = ManagerStatus.DISCONNECTED;
				this.retry = true;
				break;
			case ClientStatus.REJECTED:
				this.status = ManagerStatus.WRONG_WORKSPACE;
				this.retry = false;
				break;
		}
		this.statusChanged.fire(this.status);
		this.update_status_widget();
	}

	private retry = false;

	private retry_callback() {
		if (this.retry && !this.disposed) this.retry_connect_client();
	}

	private retry_connect_client() {
		const autoRetry = get_configuration("lsp.autoReconnect.enabled");
		const maxAttempts = get_configuration("lsp.autoReconnect.attempts");
		if (autoRetry && this.reconnectionAttempts <= maxAttempts - 1) {
			this.reconnectionAttempts++;
			this.client.connect(this.target);
			this.retry = true;
			return;
		}

		this.retry = false;
		this.status = ManagerStatus.DISCONNECTED;
		this.update_status_widget();
		this.show_retrying_prompt();
	}

	private show_retrying_prompt() {
		const lspTarget = this.get_lsp_connection_string();
		const message = `Couldn't connect to the GDScript language server at ${lspTarget}. Is the Godot editor or language server running?`;
		const options = this.target === TargetLSP.EDITOR ? ["Open workspace with Godot Editor", "Retry", "Ignore"] : ["Retry", "Ignore"];
		void vscode.window.showErrorMessage(message, ...options).then((item) => {
			if (item === "Retry") void this.connect_to_language_server();
			if (item === "Open workspace with Godot Editor") {
				void vscode.commands.executeCommand("godotTools.openEditor");
				void this.connect_to_language_server();
			}
		});
	}
}
