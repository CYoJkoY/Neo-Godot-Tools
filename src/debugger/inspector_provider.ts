import { EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, TreeView, window } from "vscode";
import { type GodotValue, GodotVariable, ObjectId, RawObject, is_gd_object } from "./debug_runtime";

export class InspectorProvider implements TreeDataProvider<RemoteProperty> {
	private changeTreeEvent = new EventEmitter<void>();
	onDidChangeTreeData = this.changeTreeEvent.event;

	private root: RemoteProperty | undefined;
	public view: TreeView<RemoteProperty>;

	constructor() {
		this.view = window.createTreeView("neoGodotTools.nodeInspector", {
			treeDataProvider: this,
		});
	}

	public clear() {
		this.view.description = undefined;
		this.view.message = undefined;

		if (this.root) {
			this.root = undefined;
			this.changeTreeEvent.fire();
		}
	}

	public fill_tree(element_name: string, class_name: string, object_id: number, variable: GodotVariable) {
		this.root = this.parse_variable(variable, object_id);
		this.root.label = element_name;
		this.root.collapsibleState = TreeItemCollapsibleState.Expanded;
		this.root.description = class_name;
		this.changeTreeEvent.fire();
	}

	public getChildren(element?: RemoteProperty): RemoteProperty[] {
		if (!this.root) {
			return [];
		}

		if (!element) {
			return [this.root];
		} else {
			return element.properties;
		}
	}

	public getTreeItem(element: RemoteProperty): TreeItem | Thenable<TreeItem> {
		return element;
	}

	public get_changed_value(parents: RemoteProperty[], property: RemoteProperty, new_parsed_value: GodotValue) {
		const value = parents[parents.length - 1].value;
		if (Array.isArray(value)) {
			const index = Number.parseInt(property.label);
			if (index < value.length) value[index] = new_parsed_value;
		} else if (value instanceof Map && property.parent) {
			// Map entries are keyed by the property that holds the key, not by its label.
			const key = property.parent.value;
			if (key !== undefined && key !== null) value.set(key, new_parsed_value);
		} else if (typeof value === "object" && value !== null && property.label in value) {
			(value as Record<string, GodotValue>)[property.label] = new_parsed_value;
		}

		return value;
	}

	public get_top_item(): RemoteProperty | undefined {
		if (this.root) {
			return this.root;
		}
		return undefined;
	}

	public has_tree() {
		return this.root !== undefined;
	}

	private parse_variable(va: GodotVariable, object_id?: number): RemoteProperty {
		const value = va.value;
		let rendered_value = "";

		if (typeof value === "number") {
			if (Number.isInteger(value)) {
				rendered_value = `${value}`;
			} else {
				rendered_value = `${Number.parseFloat(value.toFixed(5))}`;
			}
		} else if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "string") {
			rendered_value = `${value}`;
		} else if (typeof value === "undefined") {
			rendered_value = "null";
		} else {
			if (Array.isArray(value)) {
				rendered_value = `Array[${value.length}]`;
			} else if (value instanceof Map) {
				if (value instanceof RawObject) {
					rendered_value = `${value.class_name}`;
				} else {
					rendered_value = `Dictionary[${value.size}]`;
				}
			} else if (is_gd_object(value)) {
				rendered_value = `${value.type_name()}${value.stringify_value()}`;
			}
		}

		let child_props: RemoteProperty[] = [];

		if (value) {
			let sub_variables: GodotVariable[] = [];
			if (is_gd_object(value) && !(value instanceof ObjectId)) {
				sub_variables = value.sub_values();
			} else if (Array.isArray(value)) {
				sub_variables = value.map((element, i) => ({ name: `${i}`, value: element }));
			} else if (value instanceof Map) {
				sub_variables = Array.from(value.keys()).map((key) => ({
					name: is_gd_object(key) ? `${key.stringify_value()}` : `${key}`,
					value: value.get(key),
				}));
			}

			child_props = sub_variables.map((va) => this.parse_variable(va, object_id));
		}

		const out_prop = new RemoteProperty(
			va.name,
			value,
			object_id || 0,
			child_props,
			child_props.length === 0 ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Collapsed,
		);
		out_prop.description = rendered_value;
		for (const prop of out_prop.properties) {
			prop.parent = out_prop;
		}
		out_prop.description = rendered_value;

		if (value instanceof ObjectId) {
			out_prop.contextValue = "remote_object";
			out_prop.object_id = Number(value.id);
		} else if (
			typeof value === "number" ||
			typeof value === "bigint" ||
			typeof value === "boolean" ||
			typeof value === "string"
		) {
			out_prop.contextValue = "editable_value";
		} else if (Array.isArray(value) || (value instanceof Map && value instanceof RawObject === false)) {
			for (const prop of out_prop.properties) {
				prop.parent = out_prop;
			}
		}

		return out_prop;
	}
}

export class RemoteProperty extends TreeItem {
	public changes_parent?: boolean;
	public parent?: RemoteProperty;

	constructor(
		public override label: string,
		public value: GodotValue,
		public object_id: number | undefined,
		public properties: RemoteProperty[],
		public override collapsibleState?: TreeItemCollapsibleState,
	) {
		super(label, collapsibleState);
	}
}

export class RemoteObject extends RemoteProperty {}
