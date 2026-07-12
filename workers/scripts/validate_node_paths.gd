#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Headless node-path integrity check (M-11 / §4.1 multi-layer validation).
# Invoked by run-generation.sh after staging reimport:
#   godot --headless --path "$STAGING" --script workers/scripts/validate_node_paths.gd
#
# Loads every .tscn under res:// and instantiates it. Failures (broken load or
# instantiate) are reported and exit non-zero so the worker can PATCH
# VALIDATION_FAILED + E003.

func _init() -> void:
	# Defer until the main loop is live so ResourceLoader is ready.
	call_deferred("_run_validation")


func _run_validation() -> void:
	var errors: Array = []
	var dir := DirAccess.open("res://")
	if dir == null:
		_fail(["failed to open res:// (is --path a valid Godot project?)"])
		return
	_scan(dir, "res://", errors)
	if errors.size() > 0:
		_fail(errors)
	else:
		print("NODE_PATH_OK")
		print("node path validation ok")
		quit(0)


func _fail(errors: Array) -> void:
	for e in errors:
		var msg := str(e)
		push_error(msg)
		# Structured prefix for log scrapers in run-generation.sh
		print("NODE_PATH_ERROR: ", msg)
	print("NODE_PATH_FAILED count=", errors.size())
	quit(1)


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
			else:
				errors.append("failed to open directory " + full)
		elif name.ends_with(".tscn"):
			# Prefer ResourceLoader so missing/corrupt scenes surface clearly.
			if not ResourceLoader.exists(full):
				errors.append("resource missing or unloadable: " + full)
			else:
				var ps: PackedScene = load(full) as PackedScene
				if ps == null:
					errors.append("failed to load " + full)
				else:
					var inst := ps.instantiate()
					if inst == null:
						errors.append("failed to instantiate " + full)
					else:
						inst.free()
		name = dir.get_next()
	dir.list_dir_end()
