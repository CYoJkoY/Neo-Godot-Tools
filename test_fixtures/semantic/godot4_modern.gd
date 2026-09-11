extends Node
class_name ModernActor

@export var health: int = 100
@onready var label: Node = $Label
var base_health: int = 100

func get_health() -> int:
	return health

func make_child() -> ModernActor:
	var child := ModernActor.new()
	return child

func _ready() -> void:
	await get_tree().process_frame
