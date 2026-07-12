#!/usr/bin/env -S godot --headless --script
extends SceneTree

# EditorScript-style headless node-path integrity check (§4.1)
func _init() -> void:
	var errors: Array = []
	var dir := DirAccess.open("res://")
	if dir:
		_scan(dir, "res://", errors)
	if errors.size() > 0:
		for e in errors:
			push_error(str(e))
		quit(1)
	else:
		print("node path validation ok")
		quit(0)

func _scan(dir: DirAccess, path: String, errors: Array) -> void:
	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if name.begins_with("."):
			name = dir.get_next()
			continue
		var full := path.path_join(name)
		if dir.current_is_dir():
			var sub := DirAccess.open(full)
			if sub:
				_scan(sub, full, errors)
		elif name.ends_with(".tscn"):
			var ps: PackedScene = load(full)
			if ps == null:
				errors.append("failed to load " + full)
			else:
				var inst := ps.instantiate()
				if inst == null:
					errors.append("failed to instantiate " + full)
				else:
					inst.free()
		name = dir.get_next()
