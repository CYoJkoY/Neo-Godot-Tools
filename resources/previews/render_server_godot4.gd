extends SceneTree

# Offscreen render service for Godot 4 projects. Godot 4 headless mode cannot
# produce frames, so the editor launches this with a window parked offscreen.

var request_dir := ""
var viewport: SubViewport = null


func _init() -> void:
    request_dir = OS.get_environment("NEO_PREVIEW_DIR").replace("\\", "/")
    call_deferred("_serve")


func _write_text(path: String, text: String) -> void:
    var file := FileAccess.open(path, FileAccess.WRITE)
    if file == null:
        push_error("NEO_PREVIEW cannot write " + path)
        return
    file.store_string(text)
    file.close()


func _serve() -> void:
    Engine.max_fps = 20
    _ensure_viewport()
    _write_text(request_dir + "/NEO_PREVIEW_READY", "{\"engine\":\"4\"}")
    print("NEO_SERVER_READY")
    while true:
        var handled: bool = await _process_next()
        if not handled:
            await create_timer(0.05).timeout


func _pending_requests() -> PackedStringArray:
    var files := PackedStringArray()
    var dir := DirAccess.open(request_dir)
    if dir == null:
        return files
    for entry in dir.get_files():
        if entry.begins_with("request-") and entry.ends_with(".json"):
            files.append(entry)
    files.sort()
    return files


func _process_next() -> bool:
    var files := _pending_requests()
    if files.is_empty():
        return false
    var file_name := files[0]
    var text := FileAccess.get_file_as_string(request_dir + "/" + file_name)
    DirAccess.remove_absolute(request_dir + "/" + file_name)
    var parsed: Variant = JSON.parse_string(text)
    if parsed is Dictionary:
        await _handle(file_name, parsed)
    return true


func _ensure_viewport() -> void:
    if viewport != null:
        return
    viewport = SubViewport.new()
    viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    viewport.own_world_3d = true
    get_root().add_child(viewport)


func _clear() -> void:
    while viewport.get_child_count() > 0:
        var child := viewport.get_child(0)
        viewport.remove_child(child)
        child.free()


func _strip_scripts(node: Node) -> void:
    if node.get_script() != null:
        node.set_script(null)
    for child in node.get_children():
        _strip_scripts(child)


func _node_rect(node: Node, current: Variant) -> Variant:
    var rect: Variant = null
    if node is Control:
        rect = node.get_global_rect()
    elif node is Node2D:
        rect = Rect2(node.global_position, Vector2.ZERO)
        if node is Sprite2D and node.texture != null:
            rect = Rect2(node.global_position - node.offset, node.texture.get_size() * node.global_scale)
        elif node is Polygon2D and node.polygon.size() > 0:
            var polygon := Rect2(node.polygon[0], Vector2.ZERO)
            for point in node.polygon:
                polygon = polygon.expand(point)
            rect = node.global_transform * polygon
        elif node is Line2D and node.points.size() > 0:
            var line := Rect2(node.points[0], Vector2.ZERO)
            for point in node.points:
                line = line.expand(point)
            rect = node.global_transform * line
    if rect != null:
        current = rect if current == null else current.merge(rect)
    for child in node.get_children():
        current = _node_rect(child, current)
    return current


func _apply_layer_transform(node: Node, transform: Transform2D) -> void:
    for child in node.get_children():
        if child is CanvasLayer:
            child.transform = transform
        _apply_layer_transform(child, transform)


func _frame_2d(root: Node) -> bool:
    var rect: Variant = _node_rect(root, null)
    if rect == null or rect.size.x <= 0 or rect.size.y <= 0:
        return false
    var margin := 8.0
    var zoom := minf(
        (viewport.size.x - margin * 2) / rect.size.x,
        (viewport.size.y - margin * 2) / rect.size.y
    )
    zoom = minf(zoom, 4.0)
    var center: Vector2 = rect.position + rect.size * 0.5
    var transform := Transform2D(
        Vector2(zoom, 0),
        Vector2(0, zoom),
        -center * zoom + Vector2(viewport.size) * 0.5
    )
    viewport.canvas_transform = transform
    _apply_layer_transform(root, transform)
    return true


func _mesh_bounds(node: Node, current: Variant) -> Variant:
    var bounds: Variant = current
    if node is MeshInstance3D and node.mesh != null:
        var box: AABB = node.global_transform * node.mesh.get_aabb()
        bounds = box if bounds == null else bounds.merge(box)
    for child in node.get_children():
        bounds = _mesh_bounds(child, bounds)
    return bounds


func _disable_cameras(node: Node) -> void:
    if node is Camera3D:
        node.current = false
    for child in node.get_children():
        _disable_cameras(child)


func _has_light(node: Node) -> bool:
    if node is Light3D:
        return true
    for child in node.get_children():
        if _has_light(child):
            return true
    return false


func _frame_3d(root: Node) -> bool:
    var bounds: Variant = _mesh_bounds(root, null)
    if bounds == null or bounds.size.length() <= 0:
        return false
    var center: Vector3 = bounds.position + bounds.size * 0.5
    var radius: float = bounds.size.length() * 0.5 + 0.001
    _disable_cameras(root)
    var camera := Camera3D.new()
    camera.fov = 55.0
    camera.near = max(0.01, radius * 0.01)
    camera.far = max(100.0, radius * 20.0)
    viewport.add_child(camera)
    var direction := Vector3(1, 0.8, 1).normalized()
    camera.position = center + direction * radius * 2.2
    camera.look_at(center, Vector3.UP)
    camera.current = true
    if not _has_light(root):
        var light := DirectionalLight3D.new()
        light.light_energy = 1.1
        light.rotation_degrees = Vector3(-50, -30, 0)
        viewport.add_child(light)
    return true


func _render_scene(request: Dictionary) -> String:
    var source := String(request.get("source", ""))
    if source == "":
        return "scene_path_missing"
    var packed: Variant = load(source)
    if packed == null:
        return "scene_load_failed"
    if not packed is PackedScene:
        return "scene_load_failed"
    var root: Node = packed.instantiate()
    if root == null:
        return "scene_instance_failed"
    _strip_scripts(root)
    viewport.add_child(root)
    if not _frame_2d(root):
        _frame_3d(root)
    return ""


func _checker_texture() -> Texture2D:
    var image := Image.create(128, 128, false, Image.FORMAT_RGBA8)
    for y in range(128):
        for x in range(128):
            var light: bool = ((x / 16) + (y / 16)) % 2 == 0
            var value: float = 0.18 if light else 0.24
            image.set_pixel(x, y, Color(value, value, value, 1.0))
    return ImageTexture.create_from_image(image)


func _shader_stage(code: String) -> String:
    for line in code.split("\n"):
        var statement := line.strip_edges().split(";")[0].strip_edges()
        if statement.begins_with("shader_type"):
            var parts := statement.split(" ", false)
            if parts.size() >= 2:
                return parts[1]
    return ""


func _render_canvas_shader(material: ShaderMaterial) -> String:
    var rect := TextureRect.new()
    rect.texture = _checker_texture()
    rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
    rect.stretch_mode = TextureRect.STRETCH_SCALE
    rect.size = Vector2(viewport.size)
    rect.position = Vector2.ZERO
    rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
    rect.material = material
    viewport.add_child(rect)
    return ""


func _world_environment(environment: Environment) -> void:
    var world := WorldEnvironment.new()
    world.environment = environment
    viewport.add_child(world)


func _render_spatial_shader(material: ShaderMaterial) -> String:
    var quad := QuadMesh.new()
    quad.size = Vector2(4.2, 2.4)
    var mesh := MeshInstance3D.new()
    mesh.mesh = quad
    mesh.material_override = material
    viewport.add_child(mesh)
    var environment := Environment.new()
    environment.background_mode = Environment.BG_COLOR
    environment.background_color = Color(0.11, 0.1, 0.09, 1.0)
    environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
    environment.ambient_light_color = Color(0.62, 0.6, 0.56, 1.0)
    environment.ambient_light_energy = 0.55
    _world_environment(environment)
    var light := DirectionalLight3D.new()
    light.rotation_degrees = Vector3(-35, -25, 0)
    light.light_energy = 1.2
    viewport.add_child(light)
    var camera := Camera3D.new()
    camera.fov = 55.0
    camera.position = Vector3(0, 0, 3.4)
    viewport.add_child(camera)
    camera.current = true
    return ""


func _render_sky_shader(material: ShaderMaterial) -> String:
    var sky := Sky.new()
    sky.sky_material = material
    var environment := Environment.new()
    environment.background_mode = Environment.BG_SKY
    environment.sky = sky
    environment.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
    _world_environment(environment)
    var camera := Camera3D.new()
    camera.position = Vector3(0, 0, 1)
    viewport.add_child(camera)
    camera.current = true
    return ""


func _render_shader(request: Dictionary) -> String:
    var code := String(request.get("shader", ""))
    if code.strip_edges() == "":
        return "shader_is_empty"
    var stage := _shader_stage(code)
    if stage == "":
        return "shader_type_missing"
    var shader := Shader.new()
    shader.code = code
    var material := ShaderMaterial.new()
    material.shader = shader
    if stage == "canvas_item":
        return _render_canvas_shader(material)
    if stage == "spatial":
        return _render_spatial_shader(material)
    if stage == "sky":
        return _render_sky_shader(material)
    return "shader_type_unsupported"


func _handle(file_name: String, request: Dictionary) -> void:
    var started := Time.get_ticks_msec()
    var response := {"ok": false}
    _ensure_viewport()
    viewport.size = Vector2i(int(request.get("width", 640)), int(request.get("height", 640)))
    viewport.canvas_transform = Transform2D()
    _clear()
    var error := ""
    var kind := String(request.get("kind", "scene"))
    if kind == "shader":
        error = _render_shader(request)
    elif kind == "scene":
        error = _render_scene(request)
    else:
        error = "unknown_kind"
    await process_frame
    await process_frame
    await RenderingServer.frame_post_draw
    var image := viewport.get_texture().get_image()
    image.flip_y()
    if error == "":
        var out := String(request.get("out", ""))
        var result := image.save_png(out)
        if result != OK:
            error = "save_failed_%d" % result
        else:
            response["ok"] = true
            response["width"] = image.get_width()
            response["height"] = image.get_height()
    if error != "":
        response["error"] = error
    response["ms"] = Time.get_ticks_msec() - started
    var id := file_name.trim_prefix("request-").trim_suffix(".json")
    _write_text(request_dir + "/response-" + id + ".json", JSON.stringify(response))
