extends Node
class_name LegacyActor

export(int) var health = 100
onready var label = $Label
var base_health: int = 100

func get_health():
	return health

func make_child():
	var child := LegacyActor.new()
	return child

func _ready():
	yield(get_tree(), "idle_frame")
