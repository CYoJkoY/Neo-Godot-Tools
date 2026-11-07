extends SceneTree

# Offscreen render service for Godot 3 projects.
# Reads request-<id>.json files from NEO_PREVIEW_DIR, writes response-<id>.json
# and a PNG. Runs without a window so the user's project is never opened.

var request_dir = ""
var viewport = null


func _init():
    request_dir = OS.get_environment("NEO_PREVIEW_DIR").replace("\\", "/")
    call_deferred("_serve")


func _write_text(path, text):
    var file = File.new()
    if file.open(path, File.WRITE) != OK:
        push_error("NEO_PREVIEW cannot write " + path)
        return
    file.store_string(text)
    file.close()


func _serve():
    Engine.target_fps = 20
    _ensure_viewport()
    _write_text(request_dir + "/NEO_PREVIEW_READY", "{\"engine\":\"3\"}")
    print("NEO_SERVER_READY")
    while true:
        _process_next()
        yield(self, "idle_frame")


func _pending_requests():
    var files = []
    var dir = Directory.new()
    if dir.open(request_dir) != OK:
        return files
    dir.list_dir_begin(true, true)
    var entry = dir.get_next()
    while entry != "":
        if entry.begins_with("request-") and entry.ends_with(".json"):
            files.append(entry)
        entry = dir.get_next()
    dir.list_dir_end()
    files.sort()
    return files


func _process_next():
    var files = _pending_requests()
    if files.size() == 0:
        return
    var file_name = files[0]
    var text = ""
    var file = File.new()
    if file.open(request_dir + "/" + file_name, File.READ) != OK:
        return
    text = file.get_as_text()
    file.close()
    Directory.new().remove(request_dir + "/" + file_name)
    var request = parse_json(text)
    if typeof(request) == TYPE_DICTIONARY:
        yield(_handle(file_name, request), "completed")


func _ensure_viewport():
    if viewport != null:
        return
    viewport = Viewport.new()
    viewport.render_target_update_mode = Viewport.UPDATE_ALWAYS
    viewport.own_world = true
    get_root().add_child(viewport)


func _clear():
    while viewport.get_child_count() > 0:
        var child = viewport.get_child(0)
        viewport.remove_child(child)
        child.free()


func _strip_scripts(node):
    if node.get_script() != null:
        node.set_script(null)
    for child in node.get_children():
        _strip_scripts(child)


func _node_rect(node, current):
    var rect = null
    if node is Control:
        rect = node.get_global_rect()
    elif node is Node2D:
        rect = Rect2(node.global_position, Vector2.ZERO)
        if node is Sprite and node.texture != null:
            rect = Rect2(node.global_position - node.offset, node.texture.get_size() * node.global_scale)
        elif node is Polygon2D and node.polygon.size() > 0:
            var polygon = Rect2(node.polygon[0], Vector2.ZERO)
            for point in node.polygon:
                polygon = polygon.expand(point)
            rect = node.global_transform.xform(polygon)
        elif node is Line2D and node.points.size() > 0:
            var line = Rect2(node.points[0], Vector2.ZERO)
            for point in node.points:
                line = line.expand(point)
            rect = node.global_transform.xform(line)
    if rect != null:
        current = rect if current == null else current.merge(rect)
    for child in node.get_children():
        current = _node_rect(child, current)
    return current


func _apply_layer_transform(node, transform):
    for child in node.get_children():
        if child is CanvasLayer:
            child.transform = transform
        _apply_layer_transform(child, transform)


func _frame_2d(root):
    var rect = _node_rect(root, null)
    if rect == null or rect.size.x <= 0 or rect.size.y <= 0:
        return false
    var margin = 8.0
    var zoom = min((viewport.size.x - margin * 2) / rect.size.x, (viewport.size.y - margin * 2) / rect.size.y)
    zoom = min(zoom, 4.0)
    var center = rect.position + rect.size * 0.5
    var transform = Transform2D(Vector2(zoom, 0), Vector2(0, zoom), -center * zoom + viewport.size * 0.5)
    viewport.canvas_transform = transform
    _apply_layer_transform(root, transform)
    return true


func _mesh_bounds(node, current):
    var bounds = current
    if node is MeshInstance and node.mesh != null:
        var box = node.global_transform.xform(node.mesh.get_aabb())
        bounds = box if bounds == null else bounds.merge(box)
    for child in node.get_children():
        bounds = _mesh_bounds(child, bounds)
    return bounds


func _disable_cameras(node):
    if node is Camera:
        node.current = false
    for child in node.get_children():
        _disable_cameras(child)


func _has_light(node):
    if node is Light:
        return true
    for child in node.get_children():
        if _has_light(child):
            return true
    return false


func _frame_3d(root):
    var bounds = _mesh_bounds(root, null)
    if bounds == null or bounds.size.length() <= 0:
        return false
    var center = bounds.position + bounds.size * 0.5
    var radius = bounds.size.length() * 0.5 + 0.001
    _disable_cameras(root)
    var camera = Camera.new()
    camera.fov = 55.0
    camera.near = max(0.01, radius * 0.01)
    camera.far = max(100.0, radius * 20.0)
    viewport.add_child(camera)
    var direction = Vector3(1, 0.8, 1).normalized()
    camera.look_at_from_position(center + direction * radius * 2.2, center, Vector3(0, 1, 0))
    camera.current = true
    if not _has_light(root):
        var light = DirectionalLight.new()
        light.light_energy = 1.1
        light.rotation_degrees = Vector3(-50, -30, 0)
        viewport.add_child(light)
    return true


func _render_scene(request):
    var source = String(request.get("source", ""))
    if source == "":
        return "scene_path_missing"
    var packed = load(source)
    if packed == null:
        return "scene_load_failed"
    var root = packed.instance()
    if root == null:
        return "scene_instance_failed"
    _strip_scripts(root)
    viewport.add_child(root)
    if not _frame_2d(root):
        _frame_3d(root)
    return ""


func _checker_texture():
    var image = Image.new()
    image.create(128, 128, false, Image.FORMAT_RGBA8)
    image.lock()
    for y in range(128):
        for x in range(128):
            var light = ((x / 16) + (y / 16)) % 2 == 0
            var value = 0.18 if light else 0.24
            image.set_pixel(x, y, Color(value, value, value, 1.0))
    image.unlock()
    var texture = ImageTexture.new()
    texture.create_from_image(image, Texture.FLAG_REPEAT | Texture.FLAG_FILTER)
    return texture


func _shader_stage(code):
    for line in code.split("\n"):
        var statement = line.strip_edges().split(";")[0].strip_edges()
        if statement.begins_with("shader_type"):
            var parts = statement.split(" ", false)
            if parts.size() >= 2:
                return parts[1]
    return ""


func _render_canvas_shader(material):
    var rect = TextureRect.new()
    rect.texture = _checker_texture()
    rect.expand = true
    rect.stretch_mode = TextureRect.STRETCH_SCALE
    rect.rect_position = Vector2.ZERO
    rect.rect_size = viewport.size
    rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
    rect.material = material
    viewport.add_child(rect)
    return ""


func _shader_environment():
    var environment = Environment.new()
    environment.background_mode = Environment.BG_COLOR
    environment.background_color = Color(0.11, 0.1, 0.09, 1.0)
    environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
    environment.ambient_light_color = Color(0.62, 0.6, 0.56, 1.0)
    environment.ambient_light_energy = 0.55
    var world = WorldEnvironment.new()
    world.environment = environment
    viewport.add_child(world)
    return world


func _render_spatial_shader(material):
    var quad = QuadMesh.new()
    quad.size = Vector2(4.2, 2.4)
    var mesh = MeshInstance.new()
    mesh.mesh = quad
    mesh.material_override = material
    viewport.add_child(mesh)
    _shader_environment()
    var light = DirectionalLight.new()
    light.rotation_degrees = Vector3(-35, -25, 0)
    light.light_energy = 1.2
    viewport.add_child(light)
    var camera = Camera.new()
    camera.fov = 55.0
    camera.translation = Vector3(0, 0, 3.4)
    viewport.add_child(camera)
    camera.current = true
    return ""


func _render_shader(request):
    var code = String(request.get("shader", ""))
    if code.strip_edges() == "":
        return "shader_is_empty"
    var stage = _shader_stage(code)
    if stage == "":
        return "shader_type_missing"
    var shader = Shader.new()
    shader.code = code
    var material = ShaderMaterial.new()
    material.shader = shader
    if stage == "canvas_item":
        return _render_canvas_shader(material)
    if stage == "spatial":
        return _render_spatial_shader(material)
    if stage == "sky":
        return "shader_type_requires_godot4"
    return "shader_type_unsupported"


func _handle(file_name, request):
    var started = OS.get_ticks_msec()
    var response = {"ok": false}
    _ensure_viewport()
    viewport.size = Vector2(int(request.get("width", 640)), int(request.get("height", 640)))
    viewport.canvas_transform = Transform2D()
    _clear()
    var error = ""
    var kind = String(request.get("kind", "scene"))
    if kind == "shader":
        error = _render_shader(request)
    elif kind == "scene":
        error = _render_scene(request)
    else:
        error = "unknown_kind"
    yield(self, "idle_frame")
    yield(self, "idle_frame")
    yield(VisualServer, "frame_post_draw")
    var image = viewport.get_texture().get_data()
    image.flip_y()
    if error == "":
        var out = String(request.get("out", ""))
        var result = image.save_png(out)
        if result != OK:
            error = "save_failed_" + str(result)
        else:
            response["ok"] = true
            response["width"] = image.get_width()
            response["height"] = image.get_height()
    if error != "":
        response["error"] = error
    response["ms"] = OS.get_ticks_msec() - started
    var id = file_name.trim_prefix("request-").trim_suffix(".json")
    _write_text(request_dir + "/response-" + id + ".json", to_json(response))
