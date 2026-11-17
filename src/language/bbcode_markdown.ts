/**
 * Renders the BBCode of a GDScript docstring as Markdown for a hover.
 *
 * Godot documents its API in BBCode, and the `##` comments of a script use the
 * same tags. Markdown has no equivalent for most of them, so each tag is
 * translated into what a hover can display: runs of `[br]` become paragraph
 * breaks, code keeps its content literal, references become inline code, and
 * layout tags that only matter inside the editor are dropped.
 */

/** A code block or inline span, replaced by this marker while tags are applied. */
const PLACEHOLDER = "\u0000";

const placeholder = (index: number): string => `${PLACEHOLDER}${index}${PLACEHOLDER}`;

/** Fenced blocks: `[codeblock]`, `[codeblock lang=…]`, `[gdscript]`, `[csharp]`. */
const FENCED_BLOCK = /\[(codeblock|gdscript|csharp)((?:\s[^\]]*)?)\]\n?([\s\S]*?)\[\/\1\]/g;

/** Inline `[code]` and `[code skip-lint]` spans. */
const INLINE_CODE = /\[code(?:\s[^\]]*)?\]([\s\S]*?)\[\/code\]/g;

/** A keyboard key span, whose content Godot treats as literal text. */
const KBD = /\[kbd\]([\s\S]*?)\[\/kbd\]/g;

/**
 * Markdown a docstring may already contain; its content is literal for
 * Markdown. Both forms allow fences longer than three characters and the
 * `~~~` alternative, and a span closes on a run of exactly its own length.
 *
 * A fence closes on a run of the same character that is at least as long as
 * the opener: `\2` repeats the opener and `\3*` allows extra characters, so a
 * fence opened with three backticks may close with four.
 *
 * Each line may also start with block quote markers, because Markdown allows a
 * fence inside a quote. The prefixes are part of the opener and the closer but
 * not of the fence length, which the backreference counts on its own.
 */
const MARKDOWN_FENCE = /^(?: {0,3}>[ \t]?)* {0,3}((`|~)\2{2,})[^\n]*\n[\s\S]*?^(?: {0,3}>[ \t]?)* {0,3}\1\2*[ \t]*$/gm;
const MARKDOWN_CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n\n)[\s\S])*?(?<!`)\1(?!`)/g;

/** A Markdown link definition, whose label a shortcut reference may reuse. */
const LINK_DEFINITION = /^ {0,3}\[([^\[\]\n]+)\]:/gm;

/** Table rows; each `[cell]` of a row is a column, and `[table=N]` declares them. */
const TABLE = /\[table(?:=(\d+))?(?:[=\s][^\]]*)?\]([\s\S]*?)\[\/table\]/g;
const CELL = /\[cell(?:[=\s][^\]]*)?\]([\s\S]*?)\[\/cell\]/g;

/**
 * An image tag. Its content is a resource path rather than text, and a hover
 * cannot load `res://`, so the whole tag goes instead of its path.
 */
const IMAGE = /\[img(?:[=\s][^\]]*)?\][\s\S]*?\[\/img\]/g;

/** Lists, whose items Godot writes one per line. */
const UNORDERED_LIST = /\[ul\]([\s\S]*?)\[\/ul\]/g;
const ORDERED_LIST = /\[ol\]([\s\S]*?)\[\/ol\]/g;

/**
 * Reference tags that name a symbol; `[param]` shares the shape. The name is
 * everything up to the closing bracket because Godot writes more than a dotted
 * path in some forms: `[annotation @GDScript.@rpc]` repeats the `@`, and
 * `[operator Color.operator *]` ends in the operator symbol.
 */
const REFERENCE =
	/\[(?:method|constructor|operator|member|constant|enum|signal|theme_item|annotation|param)\s+([^\[\]\n]+)\]/g;

/**
 * A bare class reference. A preceding identifier keeps `Array[Node]` intact,
 * and a trailing `(`, `[` or `:` keeps a Markdown link label such as
 * `[Node](url)`, its reference-style form `[Node][api]`, and a link definition
 * such as `[Node]: url` intact. A label that a definition elsewhere in the
 * docstring declares is kept by `bbcodeToMarkdown`, which alone can see it.
 */
const CLASS_REFERENCE = /(?<![\w])\[([A-Z][A-Za-z0-9_.]*)\](?![([:])/g;

/** A formatting tag and the Markdown markers it becomes. */
interface FormattingTag {
	readonly tag: string;
	readonly marker: string;
}

const FORMATTING_TAGS: readonly FormattingTag[] = [
	{ tag: "b", marker: "**" },
	{ tag: "i", marker: "*" },
	{ tag: "s", marker: "~~" },
];

/** Progress of one formatting tag conversion: built text, depth and read cursor. */
interface TagScan {
	readonly text: string;
	readonly depth: number;
	readonly cursor: number;
}

/**
 * Markdown for one formatting tag, keeping a tag nested inside itself valid.
 *
 * A pair-matched replacement would close at the inner tag and leave the outer
 * closing tag behind. Nesting a style inside the same style also changes
 * nothing, so only the outermost pair emits markers: `[b]a [b]b[/b] c[/b]`
 * becomes `**a b c**` instead of an unbalanced run of asterisks. An unbalanced
 * tag is left as written rather than turned into a stray marker.
 */
const convertFormattingTag = (text: string, formatting: FormattingTag): string => {
	const pattern = new RegExp(`\\[${formatting.tag}\\]|\\[/${formatting.tag}\\]`, "g");
	const matches = Array.from(text.matchAll(pattern), (match) => ({
		at: match.index ?? 0,
		length: match[0].length,
		opening: match[0] === `[${formatting.tag}]`,
	}));
	const openings = matches.filter((match) => match.opening).length;
	if (openings * 2 !== matches.length) return text;
	const scan = matches.reduce<TagScan>(
		(state, match) => {
			const before = text.slice(state.cursor, match.at);
			const depth = match.opening ? state.depth + 1 : state.depth - 1;
			const marker = Math.min(state.depth, depth) === 0 ? formatting.marker : "";
			return { text: state.text + before + marker, depth, cursor: match.at + match.length };
		},
		{ text: "", depth: 0, cursor: 0 },
	);
	return scan.text + text.slice(scan.cursor);
};

/** Markdown for every formatting tag, one tag at a time. */
const formatTags = (text: string): string =>
	FORMATTING_TAGS.reduce((result, formatting) => convertFormattingTag(result, formatting), text);

/**
 * Tags that only affect the Godot editor layout. Their content stays; the tag
 * itself carries nothing a hover can show.
 */
const LAYOUT_TAG =
	/\[\/?(?:left|center|right|fill|color|bgcolor|fgcolor|font|font_size|outline_size|outline_color|cell|indent|img|u|codeblocks)(?:[=\s][^\]]*)?\]/g;

/** A run of `[br]` and the whitespace around it. */
const LINE_BREAK_RUN = /\s*(?:\[br\]\s*)+/g;

/**
 * Markdown for a run of breaks. A lone break stays inside its paragraph as a
 * hard line break (two trailing spaces), because a plain newline renders as a
 * space; any longer run starts a new paragraph, the closest a hover can get to
 * the blank line Godot draws.
 *
 * Only `[br]` counts. Each `##` line is a separate source line, and Godot joins
 * them as whitespace, so a `[br]` at the end of a line followed by more text is
 * one break, not a paragraph gap.
 */
const line_break = (run: string): string => {
	const breaks = (run.match(/\[br\]/g) ?? []).length;
	return breaks > 1 ? "\n\n" : "  \n";
};

/** Markdown for one reference tag; a body with no name stays as written. */
const referenceSpan = (match: string, name: string): string => {
	const trimmed = name.trim();
	return trimmed.length > 0 ? codeSpan(trimmed) : match;
};

/**
 * A fenced block and the language it declares. `[gdscript]` and `[csharp]`
 * name their language, and `[codeblock]` documents GDScript as its default
 * unless a `lang` attribute says otherwise, so the fence keeps the syntax
 * highlighting the docstring asked for.
 *
 * The fence is longer than any backtick run in the body, so a Markdown example
 * that already ends a line with three backticks stays inside the block instead
 * of closing it early.
 */
const fenced = (tag: string, attributes: string, code: string): string => {
	const body = stripWrapperNewlines(code);
	const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	const declared = /(?:^|\s)lang=([\w+#.-]+)/.exec(attributes)?.[1];
	const language = tag === "codeblock" ? (declared ?? "gdscript") : tag;
	return `${fence}${language}\n${body}\n${fence}`;
};

/**
 * Removes the newlines that separate the body from its tags. Only those are
 * removed: the first line of a GDScript sample may carry the indentation that
 * makes it readable, and trimming would shift that line out of its block.
 */
const stripWrapperNewlines = (code: string): string => code.replace(/^\r?\n/, "").replace(/\r?\n$/, "");

/** A list block; `-` for bullets, `1.` for the ordered form Markdown renumbers. */
const listBlock = (marker: string, content: string): string =>
	`\n\n${content
		.split("\n")
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.map((item) => `${marker} ${item}`)
		.join("\n")}\n\n`;

/** Consecutive groups of `size` values; the last group may be shorter. */
const chunk = <T>(values: readonly T[], size: number): readonly (readonly T[])[] =>
	Array.from({ length: Math.ceil(values.length / size) }, (_unused, index) =>
		values.slice(index * size, index * size + size),
	);

/** The cells of one source line: its `[cell]` tags, or the line as one entry. */
const lineCells = (line: string): readonly string[] => {
	const cells = Array.from(line.matchAll(CELL), (cell) => cell[1].trim());
	return cells.length > 0 ? cells : [line.trim()];
};

/**
 * Rows of a table body. Godot normally writes one row per line, but a table
 * that declares its column count (`[table=2]`) fills each row with consecutive
 * cells however the source breaks them up, so the declared count decides the
 * grouping instead of the newlines.
 */
const tableRows = (declaredColumns: number | undefined, content: string): readonly (readonly string[])[] => {
	const cells = Array.from(content.matchAll(CELL), (cell) => cell[1].trim());
	if (declaredColumns !== undefined && declaredColumns > 0 && cells.length > 0) return chunk(cells, declaredColumns);
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map(lineCells);
};

/**
 * A table block as a Markdown pipe table. The first row becomes the header,
 * because a Markdown table needs one and Godot writes the header the same way.
 * Column boundaries are what matters: dropping the tags alone would glue
 * adjacent cells together.
 */
const tableBlock = (declaredColumns: number | undefined, content: string): string => {
	const rows = tableRows(declaredColumns, content);
	if (rows.length === 0) return "";
	const columns = Math.max(...rows.map((cells) => cells.length));
	// A literal pipe would read as a column separator and shift the row.
	const cellText = (cell: string): string => cell.replaceAll("|", "\\|");
	const row = (cells: readonly string[]): string =>
		`| ${Array.from({ length: columns }, (_unused, index) => cellText(cells[index] ?? "")).join(" | ")} |`;
	const [header, ...body] = rows;
	const separator = row(Array.from({ length: columns }, () => "---"));
	return `\n\n${[row(header), separator, ...body.map(row)].join("\n")}\n\n`;
};

/**
 * Wraps `content` in a code span. Content that already holds a backtick needs a
 * longer fence, which Markdown expresses with repeated delimiters.
 */
const codeSpan = (content: string): string => {
	const text = content.trim();
	const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longestRun + 1);
	const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${padding}${text}${padding}${fence}`;
};

/** Replaces a match with a placeholder and records its rendered form. */
const stash = (blocks: string[], rendered: string): string => {
	blocks.push(rendered);
	return placeholder(blocks.length - 1);
};

/**
 * Puts the stashed blocks back. The walk goes from the last block to the first
 * because a block can contain an earlier one: a Markdown fence inside a
 * `[codeblock]` is stashed before the block that wraps it.
 */
const restore = (text: string, blocks: readonly string[]): string =>
	blocks.reduceRight((result, block, index) => result.replace(placeholder(index), () => block), text);

/**
 * Markdown for one docstring. Code is stashed first so no later rule rewrites
 * its content, then the tags are translated and the stashed code is restored.
 */
export function bbcodeToMarkdown(bbcode: string): string {
	const blocks: string[] = [];
	const stashed = bbcode
		.replaceAll(MARKDOWN_FENCE, (match) => stash(blocks, match))
		.replaceAll(MARKDOWN_CODE_SPAN, (match) => stash(blocks, match))
		// The body is resolved first: a Markdown fence inside it is already
		// stashed, and only its restored backticks tell the real fence length.
		.replaceAll(FENCED_BLOCK, (_match, tag: string, attributes: string, code: string) =>
			stash(blocks, fenced(tag, attributes, restore(code, blocks))),
		)
		.replaceAll(INLINE_CODE, (_match, content: string) => stash(blocks, codeSpan(content)))
		// `[kbd]` disables BBCode until its closing tag, so its content is
		// literal and must not reach the reference rules.
		.replaceAll(KBD, (_match, content: string) => stash(blocks, codeSpan(content)));

	// A shortcut reference such as `[Node]` resolves through a definition
	// elsewhere in the docstring, so the label is not a class reference. The
	// scan runs on the stashed text, because a definition inside code is
	// literal and Markdown cannot resolve a link through it.
	const labels = new Set(Array.from(stashed.matchAll(LINK_DEFINITION), (match) => match[1].trim().toLowerCase()));

	const converted = stashed
		.replaceAll(IMAGE, "")
		.replace(TABLE, (_match, declaredColumns: string | undefined, content: string) =>
			tableBlock(declaredColumns === undefined ? undefined : Number(declaredColumns), content),
		)
		.replace(UNORDERED_LIST, (_match, content: string) => listBlock("-", content))
		.replace(ORDERED_LIST, (_match, content: string) => listBlock("1.", content))
		.replace(LINE_BREAK_RUN, line_break)
		.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/g, "[$2]($1)")
		.replace(/\[url\]([\s\S]*?)\[\/url\]/g, "<$1>")
		.replace(REFERENCE, referenceSpan)
		.replace(CLASS_REFERENCE, (match, name: string) => (labels.has(name.toLowerCase()) ? match : codeSpan(name)))
		.replace(LAYOUT_TAG, "");

	// `[lb]` and `[rb]` escape BBCode markup, so their output is only a pair of
	// brackets once every tag is gone; escaping them before this point would
	// hand `[lb]b[rb]` to the emphasis rule as if it were a real `[b]` tag.
	const formatted = formatTags(converted).replaceAll("[lb]", "\\[").replaceAll("[rb]", "\\]");

	return restore(formatted, blocks)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
