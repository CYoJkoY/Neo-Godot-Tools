/**
 * Type declarations for runtime dependencies that ship no `.d.ts`.
 *
 * Declaring the small surface this extension actually uses keeps `strict` and
 * the no-`any` rule in force across the whole program, instead of letting a
 * single untyped dependency disable checking for every file that imports it.
 */

declare module "await-notify" {
	/** Condition variable used to await debug adapter responses. */
	export class Subject {
		wait(timeout?: number): Promise<void>;
		notify(): void;
	}
}

declare module "prismjs/components/prism-csharp" {
	import type { Grammar } from "prismjs";
	export const csharp: Grammar;
}
