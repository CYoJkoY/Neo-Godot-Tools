import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { verify_godot_version } from "../utils/godot_utils.js";
import { type EngineMajor, detectEngineMajor, findProjectRootForEntry, stripAutoloadSections } from "./render_paths.js";

const READY_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 40;
const MAX_IMAGES = 60;
const MAX_LOG_LINES = 60;
const IMAGE_MAX_AGE_MS = 30 * 60_000;
const SERVER_SCRIPT = "neo_render_server.gd";
const READY_MARKER = "NEO_PREVIEW_READY";

/** Failure raised by the native render service; `code` maps to a readable explanation. */
export interface RenderError extends Error {
	readonly code: string;
}

export const createRenderError = (code: string, message: string): RenderError =>
	Object.assign(new Error(message), { name: "RenderError", code });

export const isRenderError = (value: unknown): value is RenderError =>
	value instanceof Error && "code" in value && typeof value.code === "string";

export interface NativeRenderInput {
	kind: "scene" | "shader";
	/** Absolute path of the entry document, used to locate project.godot. */
	entryFile: string;
	/** Current editor contents, including unsaved edits. */
	text: string;
	width: number;
	height: number;
}

export interface NativeRenderOutput {
	pngPath: string;
	width: number;
	height: number;
	ms: number;
	engine: EngineMajor;
}

export interface GodotRenderer {
	readonly storageDirectory: string;
	render(input: NativeRenderInput): Promise<NativeRenderOutput>;
	dispose(): void;
}

interface Session {
	readonly major: EngineMajor;
	readonly root: string;
	readonly projectDir: string;
	readonly ipcDir: string;
	readonly links: readonly string[];
	readonly child: ChildProcessWithoutNullStreams;
	readonly log: string[];
	queue: Promise<unknown>;
	idle: NodeJS.Timeout | undefined;
}

interface RendererState {
	readonly storageDir: string;
	readonly extensionRoot: string;
	readonly sessions: Map<string, Session>;
	readonly editorPaths: Map<string, string>;
	sequence: number;
	disposed: boolean;
}

interface RenderResponse {
	readonly ok?: boolean;
	readonly error?: string;
	readonly width?: number;
	readonly height?: number;
	readonly ms?: number;
}

interface PreparedRequest {
	readonly json: Record<string, unknown>;
	readonly sceneFile: string | undefined;
}

const failureMessages: Record<string, string> = {
	scene_path_missing: "The scene file could not be located inside the project.",
	scene_load_failed: "Godot could not load this scene. Check resource paths and syntax.",
	scene_instance_failed: "Godot loaded the scene but could not instantiate it.",
	shader_is_empty: "The shader source is empty.",
	shader_type_missing: "Add a shader_type declaration before this shader can render.",
	shader_type_unsupported: "This shader stage has no standalone surface to render.",
	shader_type_requires_godot4: "Sky shaders render in Godot 4. Configure a Godot 4 executable for this project.",
	unknown_kind: "The render request asked for an unsupported preview kind.",
	project_not_found: "No project.godot was found above this file.",
	editor_path_invalid: "The configured Godot executable could not be started.",
	editor_path_missing: "No Godot executable is configured for this project version.",
	version_mismatch: "The configured executable is a different Godot major version than this project.",
	sandbox_failed: "Could not prepare an isolated copy of the project for rendering.",
	render_timeout: "Godot did not finish the preview in time.",
	startup_failed: "Godot exited before the preview service became ready.",
	save_failed: "Godot could not save the rendered image.",
};

/** Human readable explanation for a failed native render. */
export function describeRenderError(error: unknown): string {
	if (!isRenderError(error)) return error instanceof Error ? error.message : String(error);
	const base = failureMessages[error.code];
	if (base === undefined) return error.message;
	if (error.message.length === 0 || error.message === error.code) return base;
	return `${base} (${error.message})`;
}

function fail(code: string, detail: string): Promise<never> {
	return Promise.reject(createRenderError(code, detail));
}

function rejectWith(error: RenderError): Promise<never> {
	return Promise.reject(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(log: readonly string[]): string {
	return log.slice(-6).join(" | ");
}

function appendLog(log: string[], chunk: Buffer): void {
	const lines = chunk
		.toString("utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
	log.push(...lines);
	if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
}

function readDirectory(directory: string): readonly fs.Dirent[] {
	try {
		return fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

function cleanup(root: string, links: readonly string[]): void {
	links.map((link) => {
		try {
			fs.unlinkSync(link);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? String(error.code) : "";
			if (code !== "ENOENT") console.warn(`[neo-godot-tools] could not unlink preview mirror ${link}`, error);
		}
	});
	const base = path.join(os.tmpdir(), "neo-godot-preview-");
	if (!root.startsWith(base)) {
		console.warn(`[neo-godot-tools] refusing to remove unexpected preview directory ${root}`);
		return;
	}
	try {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch (error) {
		console.warn(`[neo-godot-tools] could not remove preview directory ${root}`, error);
	}
}

function pruneImages(state: RendererState, keep: string): void {
	const now = Date.now();
	readDirectory(state.storageDir)
		.filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
		.map((entry) => {
			const file = path.join(state.storageDir, entry.name);
			return { file, time: fs.statSync(file).mtimeMs };
		})
		.sort((left, right) => right.time - left.time)
		.forEach((image, index) => {
			const stale = index >= MAX_IMAGES || now - image.time > IMAGE_MAX_AGE_MS;
			if (image.file !== keep && stale) fs.rmSync(image.file, { force: true });
		});
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The render server is the process boundary; only accept the fields it promises. */
const isRenderResponse = (value: unknown): value is RenderResponse =>
	isRecord(value) &&
	(value["ok"] === undefined || typeof value["ok"] === "boolean") &&
	(value["error"] === undefined || typeof value["error"] === "string") &&
	(value["width"] === undefined || typeof value["width"] === "number") &&
	(value["height"] === undefined || typeof value["height"] === "number") &&
	(value["ms"] === undefined || typeof value["ms"] === "number");

function parseResponse(responsePath: string): RenderResponse | undefined {
	if (!fs.existsSync(responsePath)) return undefined;
	const text = fs.readFileSync(responsePath, "utf8").trim();
	if (text.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRenderResponse(parsed) ? parsed : undefined;
	} catch {
		// The response is still being written; retry on the next tick.
		return undefined;
	}
}

async function pollForReady(session: Session, deadline: number): Promise<RenderError | undefined> {
	if (fs.existsSync(path.join(session.ipcDir, READY_MARKER))) return undefined;
	if (session.child.exitCode !== null) return createRenderError("startup_failed", tail(session.log));
	if (Date.now() >= deadline) {
		return createRenderError("startup_failed", `Timed out waiting for the render service. ${tail(session.log)}`);
	}
	await delay(POLL_INTERVAL_MS);
	return pollForReady(session, deadline);
}

function waitForReady(session: Session): Promise<RenderError | undefined> {
	return pollForReady(session, Date.now() + READY_TIMEOUT_MS);
}

async function waitForResponse(
	session: Session,
	responsePath: string,
	id: string,
	deadline: number,
): Promise<RenderResponse> {
	const response = parseResponse(responsePath);
	if (response !== undefined) return response;
	if (session.child.exitCode !== null) {
		return fail("startup_failed", `Godot exited while rendering ${id}. ${tail(session.log)}`);
	}
	if (Date.now() >= deadline) return fail("render_timeout", `request ${id}`);
	await delay(POLL_INTERVAL_MS);
	return waitForResponse(session, responsePath, id, deadline);
}

async function resolveExecutable(state: RendererState, major: EngineMajor): Promise<string> {
	const cached = state.editorPaths.get(major);
	if (cached !== undefined) return cached;
	const configured = vscode.workspace
		.getConfiguration("neoGodotTools")
		.get<string>(major === "4" ? "editorPath.godot4" : "editorPath.godot3");
	if (!configured) return fail("editor_path_missing", major);
	const result = verify_godot_version(configured, major);
	if (result.status === "INVALID_EXE") return fail("editor_path_invalid", configured);
	if (result.status === "WRONG_VERSION") {
		return fail("version_mismatch", `${configured} reports ${result.version ?? "unknown"}`);
	}
	state.editorPaths.set(major, result.godotPath);
	return result.godotPath;
}

function spawnGodot(
	executable: string,
	major: EngineMajor,
	projectDir: string,
	ipcDir: string,
): ChildProcessWithoutNullStreams {
	const args =
		major === "4"
			? [
					"--path",
					projectDir,
					"--script",
					`res://${SERVER_SCRIPT}`,
					"--position",
					"20000,20000",
					"--resolution",
					"64x64",
					"--rendering-driver",
					"opengl3",
					"--audio-driver",
					"Dummy",
				]
			: [
					"--path",
					projectDir,
					"--script",
					`res://${SERVER_SCRIPT}`,
					"--no-window",
					"--resolution",
					"64x64",
					"--audio-driver",
					"Dummy",
				];
	return spawn(executable, args, {
		cwd: projectDir,
		env: { ...process.env, NEO_PREVIEW_DIR: ipcDir },
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

/** Mirrors the project into a scratch directory and drops autoloads from its config. */
function mirrorProject(
	state: RendererState,
	projectRoot: string,
	projectDir: string,
	projectText: string,
	major: EngineMajor,
	links: string[],
): void {
	fs.readdirSync(projectRoot, { withFileTypes: true }).map((entry) => {
		if (entry.name === "project.godot") return;
		const source = path.join(projectRoot, entry.name);
		const target = path.join(projectDir, entry.name);
		if (entry.isDirectory()) {
			fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
			links.push(target);
			return;
		}
		if (entry.isFile()) fs.copyFileSync(source, target);
	});
	fs.writeFileSync(path.join(projectDir, "project.godot"), stripAutoloadSections(projectText));
	fs.copyFileSync(
		path.join(state.extensionRoot, "resources", "previews", `render_server_godot${major}.gd`),
		path.join(projectDir, SERVER_SCRIPT),
	);
}

const sessionKey = (major: EngineMajor, projectRoot: string): string => `${major}:${projectRoot}`;

function forgetSession(state: RendererState, key: string, session: Session): void {
	if (state.sessions.get(key) === session) state.sessions.delete(key);
}

function stopSession(session: Session): void {
	if (session.idle !== undefined) clearTimeout(session.idle);
	session.idle = undefined;
	if (session.child.exitCode === null) session.child.kill();
	cleanup(session.root, session.links);
}

async function startSession(
	state: RendererState,
	projectRoot: string,
	projectText: string,
	major: EngineMajor,
): Promise<Session> {
	const executable = await resolveExecutable(state, major);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-godot-preview-"));
	const projectDir = path.join(root, "project");
	const ipcDir = path.join(root, "ipc");
	fs.mkdirSync(projectDir);
	fs.mkdirSync(ipcDir);
	const links: string[] = [];
	try {
		mirrorProject(state, projectRoot, projectDir, projectText, major, links);
	} catch (error) {
		cleanup(root, links);
		return fail("sandbox_failed", error instanceof Error ? error.message : String(error));
	}
	const child = spawnGodot(executable, major, projectDir, ipcDir);
	const log: string[] = [];
	child.stdout.on("data", (chunk: Buffer) => appendLog(log, chunk));
	child.stderr.on("data", (chunk: Buffer) => appendLog(log, chunk));
	const session: Session = {
		major,
		root,
		projectDir,
		ipcDir,
		links,
		child,
		log,
		queue: Promise.resolve(),
		idle: undefined,
	};
	child.once("exit", () => forgetSession(state, sessionKey(major, projectRoot), session));
	const failure = await waitForReady(session);
	if (failure === undefined) return session;
	stopSession(session);
	return rejectWith(failure);
}

async function ensureSession(
	state: RendererState,
	projectRoot: string,
	projectText: string,
	major: EngineMajor,
): Promise<Session> {
	const key = sessionKey(major, projectRoot);
	const existing = state.sessions.get(key);
	if (existing === undefined) {
		const created = await startSession(state, projectRoot, projectText, major);
		state.sessions.set(key, created);
		return created;
	}
	if (existing.idle !== undefined) clearTimeout(existing.idle);
	existing.idle = undefined;
	return existing;
}

function buildRequest(session: Session, input: NativeRenderInput, id: string, pngPath: string): PreparedRequest {
	const base = { kind: input.kind, width: input.width, height: input.height, out: pngPath };
	if (input.kind !== "scene") return { json: { ...base, shader: input.text }, sceneFile: undefined };
	const name = `neo_preview_${id}.tscn`;
	const sceneFile = path.join(session.projectDir, name);
	fs.writeFileSync(sceneFile, input.text);
	return { json: { ...base, source: `res://${name}` }, sceneFile };
}

async function dispatch(state: RendererState, session: Session, input: NativeRenderInput): Promise<NativeRenderOutput> {
	state.sequence += 1;
	const id = Date.now().toString(36) + state.sequence.toString(36);
	const pngPath = path.join(state.storageDir, `render-${session.major}-${id}.png`);
	const request = buildRequest(session, input, id, pngPath);
	const requestPath = path.join(session.ipcDir, `request-${id}.json`);
	const responsePath = path.join(session.ipcDir, `response-${id}.json`);
	try {
		fs.writeFileSync(requestPath, JSON.stringify(request.json));
		const response = await waitForResponse(session, responsePath, id, Date.now() + RENDER_TIMEOUT_MS);
		if (response.ok !== true) {
			const code = response.error ?? "unknown_error";
			return fail(code.startsWith("save_failed") ? "save_failed" : code, code);
		}
		const width = response.width ?? input.width;
		const height = response.height ?? input.height;
		pruneImages(state, pngPath);
		return { pngPath, width, height, ms: response.ms ?? 0, engine: session.major };
	} finally {
		if (request.sceneFile !== undefined) fs.rmSync(request.sceneFile, { force: true });
		fs.rmSync(requestPath, { force: true });
		fs.rmSync(responsePath, { force: true });
		scheduleIdle(state, session);
	}
}

function scheduleIdle(state: RendererState, session: Session): void {
	if (session.idle !== undefined) clearTimeout(session.idle);
	session.idle = setTimeout(() => {
		session.idle = undefined;
		Array.from(state.sessions.entries())
			.filter(([, candidate]) => candidate === session)
			.map(([key]) => state.sessions.delete(key));
		stopSession(session);
	}, IDLE_TIMEOUT_MS);
}

async function renderScene(state: RendererState, input: NativeRenderInput): Promise<NativeRenderOutput> {
	if (state.disposed) return fail("disposed", "The preview service is shutting down.");
	const projectRoot = findProjectRootForEntry(input.entryFile);
	if (projectRoot === undefined) return fail("project_not_found", "project_not_found");
	const projectText = fs.readFileSync(path.join(projectRoot, "project.godot"), "utf8");
	const major = detectEngineMajor(projectText);
	const session = await ensureSession(state, projectRoot, projectText, major);
	const job = session.queue.then(() => dispatch(state, session, input));
	session.queue = job.catch(() => undefined);
	return job;
}

/** Creates the long-lived service that owns one sandboxed Godot process per project and major. */
export function createGodotRenderer(extensionUri: vscode.Uri, storageUri: vscode.Uri): GodotRenderer {
	const storageDir = path.join(storageUri.fsPath, "previews");
	fs.mkdirSync(storageDir, { recursive: true });
	const state: RendererState = {
		storageDir,
		extensionRoot: extensionUri.fsPath,
		sessions: new Map(),
		editorPaths: new Map(),
		sequence: 0,
		disposed: false,
	};
	return {
		storageDirectory: storageDir,
		render: (input) => renderScene(state, input),
		dispose: () => {
			state.disposed = true;
			Array.from(state.sessions.values()).map((session) => stopSession(session));
			state.sessions.clear();
		},
	};
}
