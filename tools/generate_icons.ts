/**
 * Regenerates the themed Godot icons under `resources/godot_icons`.
 *
 * Godot 3 and Godot 4 ship different icon sets, so the script needs a local
 * Godot source checkout: it reads the `GDREGISTER_CLASS` / `register_class<>`
 * registrations of both branches, recolours the matching SVGs and writes the
 * light and dark variants the extension bundles.
 *
 * Usage: `npm run generate-icons -- /path/to/godot`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { extname, join } from "node:path";

const DARK_COLORS: Readonly<Record<string, string>> = {
	"#fc7f7f": "#fc9c9c",
	"#8da5f3": "#a5b7f3",
	"#e0e0e0": "#e0e0e0",
	"#c38ef1": "#cea4f1",
	"#8eef97": "#a5efac",
};

const LIGHT_COLORS: Readonly<Record<string, string>> = {
	"#fc7f7f": "#ff5f5f",
	"#8da5f3": "#6d90ff",
	"#e0e0e0": "#4f4f4f",
	"#c38ef1": "#bb6dff",
	"#8eef97": "#29d739",
};

const ICONS_PATH = "editor/icons";
const MODULES_PATH = "modules";
const OUTPUT_PATH = "resources/godot_icons";
const GODOT_3_CHECKOUT = "3.x";
const GODOT_4_CHECKOUT = "master";

const godot_path = process.argv[2];

/** Runs a git subcommand and resolves with its stdout. */
const git = (args: readonly string[]): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile("git", args, { encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});

const replace_colors = (colors: Readonly<Record<string, string>>, data: string): string =>
	Object.entries(colors).reduce((text, [from, to]) => text.replace(from, to), data);

/** `script_create` becomes `ScriptCreate`, matching Godot's icon names. */
const to_title_case = (name: string): string =>
	name
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join("");

const BASE_ICONS: readonly string[] = [
	"ArrowDown.svg",
	"ArrowLeft.svg",
	"ArrowRight.svg",
	"ArrowUp.svg",
	"GuiVisibilityHidden.svg",
	"GuiVisibilityVisible.svg",
	"GuiVisibilityXray.svg",
	"Edit.svg",
	"Help.svg",
	"HelpSearch.svg",
	"ImportCheck.svg",
	"ImportFail.svg",
	"Info.svg",
	"Play.svg",
	"PlayBackwards.svg",
	"PlayCustom.svg",
	"PlayRemote.svg",
	"PlayScene.svg",
	"PlayStart.svg",
	"Progress1.svg",
	"Progress2.svg",
	"Progress3.svg",
	"Progress4.svg",
	"Progress5.svg",
	"Progress6.svg",
	"Progress7.svg",
	"Progress8.svg",
	"Progress9.svg",
	"Reload.svg",
	"ReloadSmall.svg",
	"Script.svg",
	"ScriptCreate.svg",
	"ScriptRemove.svg",
	"Search.svg",
	"Signals.svg",
	"SignalsAndGroups.svg",
	"Slot.svg",
	"Stop.svg",
	"Lock.svg",
	"Unlock.svg",
	"Zoom.svg",
	"ZoomLess.svg",
	"ZoomMore.svg",
	"ZoomReset.svg",
];

const CLASS_PATTERNS: readonly RegExp[] = [/GDREGISTER_CLASS\((\w*)\)/, /register_class<(\w*)>/];

const get_class_list = (modules: readonly string[]): readonly string[] => {
	const files = ["scene/register_scene_types.cpp", ...modules.map((module) => join(module, "register_types.cpp"))];
	const registered = files.flatMap((file) =>
		fs
			.readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line) =>
				CLASS_PATTERNS.flatMap((pattern) => {
					const match = line.match(pattern);
					return match ? [`${match[1]}.svg`] : [];
				}),
			),
	);
	return [...BASE_ICONS, ...registered];
};

/** Modules whose directory contains an `icons` subdirectory. */
const discover_modules = (): readonly string[] =>
	fs.readdirSync(MODULES_PATH, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isDirectory()) return [];
		const module = join(MODULES_PATH, entry.name);
		const has_icons = fs
			.readdirSync(module, { withFileTypes: true })
			.some((child) => child.isDirectory() && child.name === "icons");
		return has_icons ? [module] : [];
	});

interface IconData {
	readonly name: string;
	readonly contents: string;
}

const icon_name = (file: string): string => (file.startsWith("icon_") ? to_title_case(file.replace("icon_", "")) : file);

const get_icons = (): readonly IconData[] => {
	const modules = discover_modules();
	const classes = get_class_list(modules);
	return [ICONS_PATH, ...modules.map((module) => join(module, "icons"))].flatMap((searchPath) =>
		fs
			.readdirSync(searchPath)
			.filter((file) => extname(file) === ".svg")
			.map((file) => ({ path: join(searchPath, file), name: icon_name(file) }))
			.filter((icon) => classes.includes(icon.name))
			.map((icon) => ({ name: icon.name, contents: fs.readFileSync(icon.path, "utf8") })),
	);
};

const ensure_paths = (): void => {
	[OUTPUT_PATH, join(OUTPUT_PATH, "light"), join(OUTPUT_PATH, "dark")].map((directory) =>
		fs.mkdirSync(directory, { recursive: true }),
	);
};

const themed_icons = (files: readonly IconData[], colors: Readonly<Record<string, string>>): Record<string, string> =>
	Object.fromEntries(files.map((file) => [file.name, replace_colors(colors, file.contents)]));

const write_icons = (theme: string, icons: Readonly<Record<string, string>>): void => {
	Object.entries(icons).map(([file, contents]) => fs.writeFileSync(join(OUTPUT_PATH, theme, file), contents));
};

const run = async (): Promise<void> => {
	if (godot_path === undefined) {
		console.log("Please provide the absolute path to your godot repo");
		return;
	}

	const original_cwd = process.cwd();
	process.chdir(godot_path);

	const diff = (await git(["diff", "HEAD"])).trim();
	if (diff) {
		console.log("There appear to be uncommitted changes in your godot repo");
		console.log("Revert or stash these changes and try again");
		return;
	}

	const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

	console.log("Gathering Godot 3 icons...");
	await git(["checkout", GODOT_3_CHECKOUT]);
	const godot_3 = get_icons();

	console.log("Gathering Godot 4 icons...");
	await git(["checkout", GODOT_4_CHECKOUT]);
	const godot_4 = get_icons();

	await git(["checkout", branch]);
	process.chdir(original_cwd);

	console.log(`Found ${godot_3.length + godot_4.length} icons...`);
	console.log("Generating themed icons...");
	const light_icons = { ...themed_icons(godot_3, LIGHT_COLORS), ...themed_icons(godot_4, LIGHT_COLORS) };
	const dark_icons = { ...themed_icons(godot_3, DARK_COLORS), ...themed_icons(godot_4, DARK_COLORS) };

	console.log("Ensuring output directory...");
	ensure_paths();

	console.log("Writing icons to output directory...");
	write_icons("light", light_icons);
	write_icons("dark", dark_icons);
};

void run();
