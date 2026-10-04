import * as fs from "node:fs";
import {
	Breakpoint,
	InitializedEvent,
	LoggingDebugSession,
	Source,
	TerminatedEvent,
	Thread,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Subject } from "await-notify";
import { debug } from "vscode";
import { GodotDebugData, GodotStackVars, GodotVariable } from "../debug_runtime";
import { AttachRequestArguments, LaunchRequestArguments } from "../debugger";
import { InspectorProvider } from "../inspector_provider";
import { SceneTreeProvider } from "../scene_tree_provider";
import { is_variable_built_in_type, parse_variable } from "./helpers";
import { ServerController } from "./server_controller";
import { ObjectId } from "./variables/variants";

interface Variable {
	variable: GodotVariable | undefined;
	index: number | undefined;
	/** Godot object id, a 64 bit value. */
	object_id: bigint | undefined;
}

export class GodotDebugSession extends LoggingDebugSession {
	private all_scopes: (GodotVariable | undefined)[] = [];
	public controller = new ServerController(this);
	public debug_data = new GodotDebugData(this);
	/** Injected by `GodotDebugger` when the session is created. */
	public sceneTree?: SceneTreeProvider;
	public inspector?: InspectorProvider;
	private got_scope: Subject = new Subject();
	private ongoing_inspections: bigint[] = [];
	private previous_inspections: bigint[] = [];
	private configuration_done: Subject = new Subject();
	private mode: "launch" | "attach" | "" = "";
	public inspect_callbacks: Map<bigint, (class_name: string, variable: GodotVariable) => void> = new Map();

	public constructor() {
		super();

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	public override dispose() {
		this.controller.stop();
	}

	protected override initializeRequest(
		response: DebugProtocol.InitializeResponse,
		_args: DebugProtocol.InitializeRequestArguments,
	) {
		response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsTerminateRequest = true;
		response.body.supportsEvaluateForHovers = false;
		response.body.supportsStepBack = false;
		response.body.supportsGotoTargetsRequest = false;
		response.body.supportsCancelRequest = false;
		response.body.supportsCompletionsRequest = false;
		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsDataBreakpoints = false;
		response.body.supportsBreakpointLocationsRequest = false;
		response.body.supportsConditionalBreakpoints = false;
		response.body.supportsHitConditionalBreakpoints = false;
		response.body.supportsLogPoints = false;
		response.body.supportsModulesRequest = false;
		response.body.supportsReadMemoryRequest = false;
		response.body.supportsRestartFrame = false;
		response.body.supportsRestartRequest = false;
		response.body.supportsSetExpression = false;
		response.body.supportsStepInTargetsRequest = false;
		response.body.supportsTerminateThreadsRequest = false;

		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		await this.configuration_done.wait(1000);

		this.mode = "launch";

		this.debug_data.projectPath = args.project;
		await this.controller.launch(args);

		this.sendResponse(response);
	}

	protected override async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments) {
		await this.configuration_done.wait(1000);

		this.mode = "attach";

		await this.controller.attach(args);

		this.sendResponse(response);
	}

	public override configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
		_args: DebugProtocol.ConfigurationDoneArguments,
	) {
		this.configuration_done.notify();
		this.sendResponse(response);
	}

	protected override continueRequest(
		response: DebugProtocol.ContinueResponse,
		_args: DebugProtocol.ContinueArguments,
	) {
		response.body = { allThreadsContinued: true };
		this.controller.continue();
		this.sendResponse(response);
	}

	protected override async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments,
	) {
		await debug.activeDebugSession?.customRequest("scopes", { frameId: 0 });

		if (this.all_scopes) {
			try {
				const variable = this.get_variable(args.expression, undefined, 0, undefined);
				if (variable.variable && variable.index !== undefined) {
					const parsed_variable = parse_variable(variable.variable);
					response.body = {
						result: parsed_variable.value,
						variablesReference: !is_variable_built_in_type(variable.variable) ? variable.index : 0,
					};
				}
			} catch (error) {
				response.success = false;
				response.message = (error as Error).toString();
			}
		}

		if (!response.body) {
			response.body = {
				result: "null",
				variablesReference: 0,
			};
		}

		this.sendResponse(response);
	}

	protected override nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments) {
		this.controller.next();
		this.sendResponse(response);
	}

	protected override pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments) {
		this.controller.break();
		this.sendResponse(response);
	}

	protected override async scopesRequest(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments,
	) {
		this.controller.request_stack_frame_vars(args.frameId);
		await this.got_scope.wait(2000);

		response.body = {
			scopes: [
				{ name: "Locals", variablesReference: 1, expensive: false },
				{ name: "Members", variablesReference: 2, expensive: false },
				{ name: "Globals", variablesReference: 3, expensive: false },
			],
		};
		this.sendResponse(response);
	}

	protected override setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
	) {
		const path = (args.source.path as string)?.replace(/\\/g, "/");
		const client_lines = args.lines || [];

		if (path && fs.existsSync(path)) {
			let bps = this.debug_data.get_breakpoints(path);
			const bp_lines = bps.map((bp) => bp.line);

			for (const bp of bps) {
				if (client_lines.indexOf(bp.line) === -1) {
					this.debug_data.remove_breakpoint(path, bp.line);
				}
			}
			for (const l of client_lines) {
				if (bp_lines.indexOf(l) === -1) {
					const bp = args.breakpoints?.find((bp_at_line) => bp_at_line.line === l);
					if (bp && !bp.condition) {
						this.debug_data.set_breakpoint(path, l);
					}
				}
			}

			bps = this.debug_data.get_breakpoints(path);
			// Sort to ensure breakpoints aren't out-of-order, which would confuse VS Code.
			bps.sort((a, b) => (a.line < b.line ? -1 : 1));

			response.body = {
				breakpoints: bps.map((bp) => {
					return new Breakpoint(true, bp.line, 1, new Source(bp.file.split("/").reverse()[0], bp.file));
				}),
			};

			this.sendResponse(response);
		}
	}

	protected override stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		_args: DebugProtocol.StackTraceArguments,
	) {
		if (this.debug_data.last_frame) {
			response.body = {
				totalFrames: this.debug_data.last_frames.length,
				stackFrames: this.debug_data.last_frames.map((sf) => {
					return {
						id: sf.id,
						name: sf.function,
						line: sf.line,
						column: 1,
						source: new Source(sf.file, `${this.debug_data.projectPath}/${sf.file.replace("res://", "")}`),
					};
				}),
			};
		}
		this.sendResponse(response);
	}

	protected override stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments) {
		this.controller.step();
		this.sendResponse(response);
	}

	protected override stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments) {
		this.controller.step_out();
		this.sendResponse(response);
	}

	protected override terminateRequest(
		response: DebugProtocol.TerminateResponse,
		_args: DebugProtocol.TerminateArguments,
	) {
		if (this.mode === "launch") {
			this.controller.stop();
			this.sendEvent(new TerminatedEvent());
		}
		this.sendResponse(response);
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse) {
		response.body = { threads: [new Thread(0, "thread_1")] };
		this.sendResponse(response);
	}

	protected override async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments,
	) {
		if (!this.all_scopes) {
			response.body = {
				variables: [],
			};
			this.sendResponse(response);
			return;
		}

		const reference = this.all_scopes[args.variablesReference];
		let variables: DebugProtocol.Variable[];

		if (!reference || !reference.sub_values) {
			variables = [];
		} else {
			variables = reference.sub_values
				.map((va): DebugProtocol.Variable | undefined => {
					const sva = this.all_scopes.find(
						(sva) => sva && sva.scope_path === va.scope_path && sva.name === va.name,
					);
					if (sva) {
						return parse_variable(
							sva,
							this.all_scopes.findIndex(
								(va_idx) =>
									va_idx &&
									va_idx.scope_path === `${reference.scope_path}.${reference.name}` &&
									va_idx.name === va.name,
							),
						);
					}
					return undefined;
				})
				.filter((v): v is DebugProtocol.Variable => v !== undefined);
		}

		response.body = {
			variables: variables,
		};

		this.sendResponse(response);
	}

	public set_scopes(stackVars: GodotStackVars) {
		this.all_scopes = [
			undefined,
			{
				name: "local",
				value: undefined,
				sub_values: stackVars.locals,
				scope_path: "@",
			},
			{
				name: "member",
				value: undefined,
				sub_values: stackVars.members,
				scope_path: "@",
			},
			{
				name: "global",
				value: undefined,
				sub_values: stackVars.globals,
				scope_path: "@",
			},
		];

		for (const va of stackVars.locals) {
			va.scope_path = "@.local";
			this.append_variable(va);
		}

		for (const va of stackVars.members) {
			va.scope_path = "@.member";
			this.append_variable(va);
		}

		for (const va of stackVars.globals) {
			va.scope_path = "@.global";
			this.append_variable(va);
		}

		this.add_to_inspections();

		if (this.ongoing_inspections.length === 0) {
			this.previous_inspections = [];
			this.got_scope.notify();
		}
	}

	public set_inspection(id: bigint, replacement: GodotVariable) {
		const variables = this.all_scopes.filter((va) => va && va.value instanceof ObjectId && va.value.id === id);

		for (const va of variables) {
			const index = this.all_scopes.findIndex((va_id) => va_id === va);
			const old = this.all_scopes.splice(index, 1);
			if (old[0]) {
				replacement.name = old[0].name;
				replacement.scope_path = old[0].scope_path;
			}
			this.append_variable(replacement, index);
		}

		this.ongoing_inspections.splice(
			this.ongoing_inspections.findIndex((va_id) => va_id === id),
			1,
		);

		this.previous_inspections.push(id);

		// this.add_to_inspections();

		if (this.ongoing_inspections.length === 0) {
			this.previous_inspections = [];
			this.got_scope.notify();
		}
	}

	private add_to_inspections() {
		for (const va of this.all_scopes) {
			if (va && va.value instanceof ObjectId) {
				if (
					!this.ongoing_inspections.includes(va.value.id) &&
					!this.previous_inspections.includes(va.value.id)
				) {
					this.controller.request_inspect_object(va.value.id);
					this.ongoing_inspections.push(va.value.id);
				}
			}
		}
	}

	/** The `self` scope and the script instance id Godot 3 reports next to it. */
	private self_scope(): { root: GodotVariable | undefined; object_id: bigint | undefined } {
		const root = this.all_scopes.find((scope) => scope?.name === "self");
		const id_var = this.all_scopes.find((scope) => scope?.name === "id" && scope.scope_path === "@.member.self");
		return { root, object_id: id_var?.value instanceof ObjectId ? id_var.value.id : undefined };
	}

	protected get_variable(expression: string, root?: GodotVariable, index = 0, object_id?: bigint): Variable {
		const self = root === undefined ? this.self_scope() : undefined;
		const scoped_root = root ?? self?.root;
		if (!scoped_root) {
			throw new Error("Could not find root scope");
		}
		const scoped_expression =
			root === undefined && !expression.includes("self") ? `self.${expression}` : expression;
		const scoped_object_id = root === undefined ? self?.object_id : object_id;

		const result: Variable = {
			variable: undefined,
			index: undefined,
			object_id: undefined,
		};

		const items = scoped_expression.split(".");
		let propertyName = items[index + 1];
		let path = items
			.slice(0, index + 1)
			.join(".")
			.split("self.")
			.join("")
			.split("self")
			.join("")
			.split("[")
			.join(".")
			.split("]")
			.join("");

		if (items.length === 1 && items[0] === "self") {
			propertyName = "self";
		}

		// Detect index/key
		let key = (propertyName.match(/(?<=\[).*(?=\])/) || [null])[0];
		if (key) {
			key = key.replace(/['"]+/g, "");
			propertyName = propertyName
				.split(/(?<=\[).*(?=\])/)
				.join("")
				.split("[]")
				.join("");
			if (path) path += ".";
			path += propertyName;
			propertyName = key;
		}

		function sanitizeName(name: string) {
			return name.split("Members/").join("").split("Locals/").join("");
		}

		function sanitizeScopePath(scope_path: string) {
			return scope_path
				.split("@.member.self.")
				.join("")
				.split("@.member.self")
				.join("")
				.split("@.member.")
				.join("")
				.split("@.member")
				.join("")
				.split("@.local.")
				.join("")
				.split("@.local")
				.join("")
				.split("Locals/")
				.join("")
				.split("Members/")
				.join("")
				.split("@")
				.join("");
		}

		const sanitized_all_scopes = this.all_scopes
			.filter((x): x is NonNullable<typeof x> => x !== undefined)
			.map((x) => ({
				sanitized: {
					name: sanitizeName(x.name),
					scope_path: sanitizeScopePath(x.scope_path || ""),
				},
				real: x,
			}));

		result.variable = sanitized_all_scopes.find(
			(x) => x.sanitized.name === propertyName && x.sanitized.scope_path === path,
		)?.real;
		if (!result.variable) {
			throw new Error(`Could not find: ${propertyName}`);
		}

		// `root.value` holds the sanitized scopes: a Map of scope path to the
		// collection behind it (Godot 3 answers with plain objects for members).
		if (scoped_root.value instanceof Map) {
			const entries = [...scoped_root.value.entries()];
			const scopeName = (name: unknown) =>
				typeof name === "string" ? name.split("Members/").join("").split("Locals/").join("") : "";
			const idOf = (value: unknown) => (value instanceof ObjectId ? value.id : undefined);
			if (result.variable.name === "self") {
				const idVar = this.all_scopes.find((x) => x?.name === "id" && x.scope_path === "@.member.self");
				result.object_id = idVar?.value instanceof ObjectId ? idVar.value.id : undefined;
				return result;
			}
			const container = entries.find(
				([name]) => scopeName(name) === (key ? path.split(".").at(-1) : propertyName),
			)?.[1];
			if (!key) {
				result.object_id = idOf(container);
				return result;
			}
			if (container instanceof Map) result.object_id = idOf(container.get(key));
			else if (typeof container === "object" && container !== null) {
				result.object_id = idOf((container as Record<string, unknown>)[key]);
			}
		}

		if (!result.object_id) {
			result.object_id = scoped_object_id;
		}

		if (result.variable) {
			result.index = this.all_scopes.findIndex(
				(x) => x && x.name === result.variable?.name && x.scope_path === result.variable?.scope_path,
			);
		}

		if (items.length > 2 && index < items.length - 2) {
			return this.get_variable(items.join("."), result.variable, index + 1, result.object_id);
		}

		return result;
	}

	private append_variable(variable: GodotVariable, index?: number) {
		if (index) {
			this.all_scopes.splice(index, 0, variable);
		} else {
			this.all_scopes.push(variable);
		}
		const base_path = `${variable.scope_path}.${variable.name}`;
		if (variable.sub_values) {
			variable.sub_values.forEach((va, i) => {
				va.scope_path = base_path;
				this.append_variable(va, index ? index + i + 1 : undefined);
			});
		}
	}
}
