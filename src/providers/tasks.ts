import * as vscode from "vscode";
import type { ExtensionContext, Task, TaskDefinition, TaskProvider } from "vscode";

interface GDTaskDefinition extends TaskDefinition {
	task: string;
	file?: string;
}

export type GDTaskProvider = TaskProvider;

/** A `godot test` task for the first workspace folder, when there is one. */
export function createTaskProvider(context: ExtensionContext): GDTaskProvider {
	const provider: GDTaskProvider = {
		provideTasks(): Task[] {
			const [workspaceFolder] = vscode.workspace.workspaceFolders ?? [];
			if (!workspaceFolder) return [];
			const kind: GDTaskDefinition = { type: "godot", task: "test" };
			return [new vscode.Task(kind, workspaceFolder, "test", "godot")];
		},
		resolveTask(task: Task): Task {
			return task;
		},
	};
	context.subscriptions.push(vscode.tasks.registerTaskProvider("godot", provider));
	return provider;
}
