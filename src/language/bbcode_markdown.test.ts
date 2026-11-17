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

	it("renders [param] as inline code", () => {
		assert.equal(bbcodeToMarkdown("Returns [param amount] unchanged."), "Returns `amount` unchanged.");
	});

	it("renders member references as inline code", () => {
		assert.equal(bbcodeToMarkdown("See [method Node.queue_free]."), "See `Node.queue_free`.");
	});

	it("renders a single-token reference as inline code", () => {
		assert.equal(bbcodeToMarkdown("Requires a [Node] instance."), "Requires a `Node` instance.");
	});

	it("leaves an already indexed type alone", () => {
		assert.equal(bbcodeToMarkdown("An Array[int] of values"), "An Array[int] of values");
	});

	it("renders [lb] and [rb] as brackets", () => {
		assert.equal(bbcodeToMarkdown("Write [lb]literal[rb] here"), "Write \\[literal\\] here");
	});

	it("renders emphasis tags", () => {
		assert.equal(bbcodeToMarkdown("[b]Bold[/b] and [i]italic[/i]"), "**Bold** and *italic*");
	});

	it("renders [kbd] as inline code", () => {
		assert.equal(bbcodeToMarkdown("Press [kbd]Ctrl + A[/kbd]"), "Press `Ctrl + A`");
	});

	it("renders a link", () => {
		assert.equal(
			bbcodeToMarkdown("Read [url=https://godotengine.org]the docs[/url]"),
			"Read [the docs](https://godotengine.org)",
		);
	});

	it("drops formatting tags that Markdown cannot express", () => {
		assert.equal(bbcodeToMarkdown("[center]Centered[/center]"), "Centered");
		assert.equal(bbcodeToMarkdown("[color=red]Red[/color]"), "Red");
	});
});
