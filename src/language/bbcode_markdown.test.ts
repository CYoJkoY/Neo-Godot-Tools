import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bbcodeToMarkdown } from "./bbcode_markdown.js";

describe("docstring BBCode to Markdown", () => {
	it("keeps plain text untouched", () => {
		assert.equal(bbcodeToMarkdown("Heals the player."), "Heals the player.");
	});

	it("renders one [br] as a line break", () => {
		assert.equal(bbcodeToMarkdown("Line one[br]Line two"), "Line one  \nLine two");
	});

	it("renders consecutive [br] tags as a paragraph break", () => {
		assert.equal(bbcodeToMarkdown("A[br][br]B"), "A\n\nB");
	});

	it("collapses runs of line breaks", () => {
		assert.equal(bbcodeToMarkdown("A[br][br]\n\nB[br][br]"), "A\n\nB");
	});

	it("keeps inline code literal", () => {
		assert.equal(bbcodeToMarkdown("Value [code]Array[int][/code] stays"), "Value `Array[int]` stays");
	});

	it("does not turn inline code emphasis into italics", () => {
		assert.equal(bbcodeToMarkdown("[code][i]not italics[/i][/code]"), "`[i]not italics[/i]`");
	});

	it("renders a fenced code block", () => {
		const markdown = bbcodeToMarkdown("[gdscript]\nvar speed := 1\n[/gdscript]");
		assert.equal(markdown, "```gdscript\nvar speed := 1\n```");
	});

	it("keeps the indentation of a fenced code block", () => {
		const markdown = bbcodeToMarkdown("[gdscript]\n\tvar speed := 1\n\tif speed > 0:\n\t\tpass\n[/gdscript]");
		assert.equal(markdown, "```gdscript\n\tvar speed := 1\n\tif speed > 0:\n\t\tpass\n```");
	});

	it("fences a code block with more backticks than the body contains", () => {
		const markdown = bbcodeToMarkdown("[codeblock]\n```\nexample\n```\n[/codeblock]");
		assert.equal(markdown, "````gdscript\n```\nexample\n```\n````");
	});

	it("renders [ul] items as a Markdown list", () => {
		assert.equal(bbcodeToMarkdown("Options:[ul]\nFirst\nSecond\n[/ul]"), "Options:\n\n- First\n- Second");
	});

	it("renders [ol] items as a numbered Markdown list", () => {
		assert.equal(bbcodeToMarkdown("[ol]\nFirst\nSecond\n[/ol]"), "1. First\n1. Second");
	});

	it("keeps Markdown code spans literal", () => {
		assert.equal(bbcodeToMarkdown("Set `offset` to `[param amount]`."), "Set `offset` to `[param amount]`.");
	});

	it("keeps Markdown fences literal", () => {
		assert.equal(bbcodeToMarkdown("```\n[br] stays\n```"), "```\n[br] stays\n```");
	});

	it("keeps a Markdown fence written with tildes literal", () => {
		assert.equal(bbcodeToMarkdown("~~~\n[param amount]\n~~~"), "~~~\n[param amount]\n~~~");
	});

	it("keeps a Markdown fence closed with a longer run literal", () => {
		assert.equal(bbcodeToMarkdown("```\n[param amount]\n````"), "```\n[param amount]\n````");
	});

	it("keeps a Markdown code span fenced with two backticks literal", () => {
		assert.equal(bbcodeToMarkdown("Use ``a ` [param x]`` here"), "Use ``a ` [param x]`` here");
	});

	it("renders [param] as inline code", () => {
		assert.equal(bbcodeToMarkdown("Returns [param amount] unchanged."), "Returns `amount` unchanged.");
	});

	it("renders member references as inline code", () => {
		assert.equal(bbcodeToMarkdown("See [method Node.queue_free]."), "See `Node.queue_free`.");
	});

	it("renders a single-token reference as inline code", () => {
		assert.equal(bbcodeToMarkdown("Requires a [Node] instance."), "Requires a `Node` instance.");
	});

	it("renders an operator reference as inline code", () => {
		assert.equal(bbcodeToMarkdown("See [operator Color.operator *]."), "See `Color.operator *`.");
	});

	it("renders a qualified annotation reference as inline code", () => {
		assert.equal(bbcodeToMarkdown("See [annotation @GDScript.@rpc]."), "See `@GDScript.@rpc`.");
	});

	it("does not count a source newline as a second break", () => {
		assert.equal(bbcodeToMarkdown("Line one[br]\nLine two"), "Line one  \nLine two");
	});

	it("leaves an already indexed type alone", () => {
		assert.equal(bbcodeToMarkdown("An Array[int] of values"), "An Array[int] of values");
	});

	it("keeps a Markdown link label intact", () => {
		assert.equal(bbcodeToMarkdown("See [Node](https://example.com)."), "See [Node](https://example.com).");
	});

	it("keeps a reference-style Markdown link label intact", () => {
		assert.equal(bbcodeToMarkdown("See [Node][api]."), "See [Node][api].");
	});

	it("renders [lb] and [rb] as brackets", () => {
		assert.equal(bbcodeToMarkdown("Write [lb]literal[rb] here"), "Write \\[literal\\] here");
	});

	it("renders emphasis tags", () => {
		assert.equal(bbcodeToMarkdown("[b]Bold[/b] and [i]italic[/i]"), "**Bold** and *italic*");
	});

	it("renders a nested formatting tag without leaving a closing tag behind", () => {
		assert.equal(bbcodeToMarkdown("[b]outer [b]inner[/b] tail[/b]"), "**outer inner tail**");
	});

	it("leaves an unbalanced formatting tag as written", () => {
		assert.equal(bbcodeToMarkdown("[b]open only"), "[b]open only");
	});

	it("keeps a Markdown link definition label intact", () => {
		assert.equal(bbcodeToMarkdown("[Node]: https://example.com"), "[Node]: https://example.com");
	});

	it("renders [kbd] as inline code", () => {
		assert.equal(bbcodeToMarkdown("Press [kbd]Ctrl + A[/kbd]"), "Press `Ctrl + A`");
	});

	it("fences a code span with more backticks than its content", () => {
		assert.equal(bbcodeToMarkdown("[code]a `` b[/code]"), "```a `` b```");
	});

	it("renders a link", () => {
		assert.equal(
			bbcodeToMarkdown("Read [url=https://godotengine.org]the docs[/url]"),
			"Read [the docs](https://godotengine.org)",
		);
	});

	it("renders a table as a Markdown table", () => {
		const markdown = bbcodeToMarkdown("[table]\n[cell]Name[/cell][cell]Value[/cell]\n[/table]");
		assert.equal(markdown, "| Name | Value |\n| --- | --- |");
	});

	it("keeps rows of a table written without cell tags", () => {
		assert.equal(bbcodeToMarkdown("[table]\nheader\nrow\n[/table]"), "| header |\n| --- |\n| row |");
	});

	it("escapes a pipe inside a table cell", () => {
		const markdown = bbcodeToMarkdown("[table][cell]a|b[/cell][cell]c[/cell][/table]");
		assert.equal(markdown, "| a\\|b | c |\n| --- | --- |");
	});

	it("drops formatting tags that Markdown cannot express", () => {
		assert.equal(bbcodeToMarkdown("[center]Centered[/center]"), "Centered");
		assert.equal(bbcodeToMarkdown("[color=red]Red[/color]"), "Red");
		assert.equal(bbcodeToMarkdown("[right]Right[/right]"), "Right");
		assert.equal(bbcodeToMarkdown("[fill]Filled[/fill]"), "Filled");
	});

	it("drops an image tag with its resource path", () => {
		assert.equal(bbcodeToMarkdown("See [img]res://icon.svg[/img] here"), "See  here");
	});

	it("groups table cells by the declared column count", () => {
		const markdown = bbcodeToMarkdown("[table=2][cell]a[/cell][cell]b[/cell][cell]c[/cell][cell]d[/cell][/table]");
		assert.equal(markdown, "| a | b |\n| --- | --- |\n| c | d |");
	});

	it("keeps a Markdown fence inside a block quote literal", () => {
		const markdown = bbcodeToMarkdown("Quote:\n> ```\n> [param amount]\n> ```");
		assert.equal(markdown, "Quote:\n> ```\n> [param amount]\n> ```");
	});

	it("keeps a shortcut reference link label intact", () => {
		assert.equal(
			bbcodeToMarkdown("See [Node].\n\n[Node]: https://example.com"),
			"See [Node].\n\n[Node]: https://example.com",
		);
	});

	it("keeps BBCode-shaped text inside [kbd] literal", () => {
		assert.equal(bbcodeToMarkdown("Press [kbd][param amount][/kbd]"), "Press `[param amount]`");
	});

	it("keeps the language of a code block", () => {
		assert.equal(bbcodeToMarkdown("[codeblock]\nvar a = 1\n[/codeblock]"), "```gdscript\nvar a = 1\n```");
		assert.equal(
			bbcodeToMarkdown("[codeblock lang=csharp]\nint a = 1;\n[/codeblock]"),
			"```csharp\nint a = 1;\n```",
		);
	});

	it("keeps an escaped tag literal", () => {
		assert.equal(
			bbcodeToMarkdown("Write [lb]b[rb]text[lb]/b[rb] to show bold"),
			"Write \\[b\\]text\\[/b\\] to show bold",
		);
	});
});
