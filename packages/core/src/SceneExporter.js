/**
 * 场景导出器
 *
 * 把 PersistenceManager 产出的场景快照（`{ objects, metadata }`）转换成可落盘的
 * JSON / XML 文本，并提供浏览器下载能力。
 *
 * 设计约定：
 * - 本模块是一组纯函数，不依赖 three.js，也不触碰 DOM（下载函数除外），
 *   因此可以在 Node 测试、Worker 或任何无浏览器环境里独立做序列化。
 * - JSON 文档结构与后端 `POST /api/scene/save` 的请求体保持一致（顶层多出
 *   `format` / `formatVersion` / `generator` / `exportedAt` 四个信封字段，
 *   后端会忽略未知字段），因此导出的 JSON 可以直接回灌给该接口。
 * - XML 与 JSON 同构：结构化记录（变换、材质、节点、光照）用元素属性表达，
 *   自由字段（几何参数、扩展字段）用子元素表达，保证不丢数据。
 */

export const SCENE_FORMAT = 'meteor3d-scene';
export const SCENE_FORMAT_VERSION = 1;

/** 导出文件的 MIME 类型。 */
export const SCENE_MIME_TYPES = Object.freeze({
    json: 'application/json',
    xml: 'application/xml'
});

const INDENT = '  ';
const VECTOR_KEYS = ['x', 'y', 'z'];

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 判断是否为同时具备 x/y/z 三个数值键的向量记录。 */
function isVector3(value) {
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value);
    return keys.length === 3 && VECTOR_KEYS.every((key) => typeof value[key] === 'number');
}

function escapeXmlText(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value) {
    return escapeXmlText(value)
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        // 属性值里的换行/制表符会被 XML 解析器规范化，改用字符引用保持原样
        .replace(/\r/g, '&#13;')
        .replace(/\n/g, '&#10;')
        .replace(/\t/g, '&#9;');
}

/** 把 [name, value] 列表拼成属性串；null / undefined / NaN 一律跳过。 */
function attributes(pairs) {
    let out = '';
    for (const [name, value] of pairs) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        out += ` ${name}="${escapeXmlAttribute(value)}"`;
    }
    return out;
}

const XML_NAME_PATTERN = /^[A-Za-z_][\w.\-]*$/;

/** 校验字符串能否直接用作 XML 元素名。 */
function isValidXmlName(key) {
    return XML_NAME_PATTERN.test(String(key));
}

/* ------------------------------------------------------------------ *
 * XML 写入器
 * ------------------------------------------------------------------ */

class XmlWriter {
    constructor() {
        this.lines = [];
    }

    open(depth, tag, attrPairs = []) {
        this.lines.push(`${INDENT.repeat(depth)}<${tag}${attributes(attrPairs)}>`);
    }

    close(depth, tag) {
        this.lines.push(`${INDENT.repeat(depth)}</${tag}>`);
    }

    empty(depth, tag, attrPairs = []) {
        this.lines.push(`${INDENT.repeat(depth)}<${tag}${attributes(attrPairs)}/>`);
    }

    text(depth, tag, value, attrPairs = []) {
        if (value === null || value === undefined) return;
        if (typeof value === 'number' && !Number.isFinite(value)) return;
        this.lines.push(
            `${INDENT.repeat(depth)}<${tag}${attributes(attrPairs)}>${escapeXmlText(value)}</${tag}>`
        );
    }

    toString() {
        return this.lines.join('\n');
    }
}

/* ------------------------------------------------------------------ *
 * 通用字段兜底（保证 serializeObject 新增字段后导出不丢数据）
 * ------------------------------------------------------------------ */

function writeNamedValue(writer, depth, key, value) {
    if (isValidXmlName(key)) {
        writeGenericValue(writer, depth, key, value);
        return;
    }
    // 非合法元素名（如含空格、以数字开头）退化为 <field name="...">，
    // 否则会产出无法解析的 XML。
    writer.open(depth, 'field', [['name', key]]);
    writeGenericValue(writer, depth + 1, 'value', value);
    writer.close(depth, 'field');
}

function writeGenericValue(writer, depth, name, value) {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
        if (value.length === 0) {
            writer.empty(depth, name, [['count', 0]]);
            return;
        }
        writer.open(depth, name, [['count', value.length]]);
        for (const item of value) writeGenericValue(writer, depth + 1, 'item', item);
        writer.close(depth, name);
        return;
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value).filter(([, item]) => item !== undefined);
        if (entries.length === 0) {
            writer.empty(depth, name);
            return;
        }
        writer.open(depth, name);
        for (const [key, item] of entries) writeNamedValue(writer, depth + 1, key, item);
        writer.close(depth, name);
        return;
    }

    writer.text(depth, name, value);
}

/* ------------------------------------------------------------------ *
 * 结构化记录
 * ------------------------------------------------------------------ */

function writeVector(writer, depth, tag, value) {
    if (!isVector3(value)) return;
    writer.empty(depth, tag, [
        ['x', value.x],
        ['y', value.y],
        ['z', value.z]
    ]);
}

function writeLngLat(writer, depth, tag, value) {
    if (!isPlainObject(value)) return;
    if (typeof value.lng !== 'number' && typeof value.lat !== 'number') return;
    writer.empty(depth, tag, [
        ['lng', value.lng],
        ['lat', value.lat]
    ]);
}

const ANIMATION_ATTRIBUTES = ['enabled', 'playing', 'clipIndex', 'clipName', 'speed', 'loop'];

function writeAnimation(writer, depth, animation) {
    if (!isPlainObject(animation)) return;
    const pairs = ANIMATION_ATTRIBUTES
        .filter((key) => animation[key] !== undefined)
        .map((key) => [key, animation[key]]);
    if (pairs.length === 0) return;
    writer.empty(depth, 'animation', pairs);
}

const MATERIAL_ATTRIBUTES = [
    'color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity', 'opacity',
    'alphaTest', 'blending', 'side', 'transparent', 'depthTest', 'depthWrite',
    'vertexColors', 'wireframe', 'flatShading'
];

function writeMaterial(writer, depth, material) {
    if (!isPlainObject(material)) return;

    const pairs = MATERIAL_ATTRIBUTES
        .filter((key) => material[key] !== undefined)
        .map((key) => [key, material[key]]);
    const extras = Object.entries(material).filter(([key]) => !MATERIAL_ATTRIBUTES.includes(key));

    if (extras.length === 0) {
        writer.empty(depth, 'material', pairs);
        return;
    }

    writer.open(depth, 'material', pairs);
    for (const [key, value] of extras) writeNamedValue(writer, depth + 1, key, value);
    writer.close(depth, 'material');
}

function writeGeometry(writer, depth, geometry) {
    if (!isPlainObject(geometry)) return;

    const parameters = isPlainObject(geometry.parameters) ? geometry.parameters : null;
    const entries = parameters
        ? Object.entries(parameters).filter(([, value]) => value !== null && value !== undefined)
        : [];

    if (entries.length === 0) {
        writer.empty(depth, 'geometry', [['type', geometry.type]]);
        return;
    }

    writer.open(depth, 'geometry', [['type', geometry.type]]);
    for (const [key, value] of entries) {
        writer.text(depth + 1, 'parameter', value, [['name', key]]);
    }
    writer.close(depth, 'geometry');
}

/** 节点记录（nodeBindings 的单项 / sceneGraph 的单项）共用同一结构。 */
function writeNodeRecord(writer, depth, node) {
    if (!isPlainObject(node)) return;

    writer.open(depth, 'node', [
        ['bid', node.bid],
        ['originObjectBid', node.originObjectBid],
        ['assetNodeId', node.assetNodeId],
        ['parentBid', node.parentBid],
        ['order', node.order],
        ['name', node.name],
        ['visible', node.visible]
    ]);
    writeVector(writer, depth + 1, 'position', node.position);
    writeVector(writer, depth + 1, 'rotation', node.rotation);
    writeVector(writer, depth + 1, 'scale', node.scale);
    writer.close(depth, 'node');
}

function writeNodeList(writer, depth, tag, records) {
    if (!Array.isArray(records)) return;
    if (records.length === 0) {
        writer.empty(depth, tag, [['count', 0]]);
        return;
    }
    writer.open(depth, tag, [['count', records.length]]);
    for (const record of records) writeNodeRecord(writer, depth + 1, record);
    writer.close(depth, tag);
}

const MODIFICATION_KEYS = ['visible', 'position', 'rotation', 'scale', 'material'];

function writeModifications(writer, depth, modifications) {
    if (!isPlainObject(modifications)) return;

    const entries = Object.entries(modifications).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;

    writer.open(depth, 'modifications', [['count', entries.length]]);
    for (const [key, modification] of entries) {
        const record = isPlainObject(modification) ? modification : {};
        writer.open(depth + 1, 'modification', [['key', key]]);
        writer.text(depth + 2, 'visible', record.visible);
        writeVector(writer, depth + 2, 'position', record.position);
        writeVector(writer, depth + 2, 'rotation', record.rotation);
        writeVector(writer, depth + 2, 'scale', record.scale);
        writeMaterial(writer, depth + 2, record.material);
        for (const [extraKey, extraValue] of Object.entries(record)) {
            if (MODIFICATION_KEYS.includes(extraKey)) continue;
            writeNamedValue(writer, depth + 2, extraKey, extraValue);
        }
        writer.close(depth + 1, 'modification');
    }
    writer.close(depth, 'modifications');
}

/* ------------------------------------------------------------------ *
 * 对象节点
 * ------------------------------------------------------------------ */

const OBJECT_COMMON_KEYS = ['id', 'bid', 'type', 'name', 'visible', 'position', 'rotation', 'scale'];
const OBJECT_TYPE_KEYS = {
    GLTFModel: ['url', 'assetId', 'assetVersionId', 'nodeBindings', 'animation', 'modifications'],
    Tileset: ['url', 'gisCenter'],
    GaussianSplat: ['url']
};
const PRIMITIVE_KEYS = ['geometry', 'material'];

function isModelType(type) {
    return Object.prototype.hasOwnProperty.call(OBJECT_TYPE_KEYS, type);
}

function writeObject(writer, depth, object) {
    if (!isPlainObject(object)) return;

    const type = object.type || 'Unknown';
    const known = new Set(OBJECT_COMMON_KEYS);
    for (const key of OBJECT_TYPE_KEYS[type] || []) known.add(key);
    if (!isModelType(type)) for (const key of PRIMITIVE_KEYS) known.add(key);

    writer.open(depth, 'object', [
        ['type', type],
        ['id', object.id ?? object.bid],
        ['bid', object.bid ?? object.id],
        ['name', object.name],
        ['visible', object.visible]
    ]);

    writeVector(writer, depth + 1, 'position', object.position);
    writeVector(writer, depth + 1, 'rotation', object.rotation);
    writeVector(writer, depth + 1, 'scale', object.scale);

    writer.text(depth + 1, 'url', object.url);
    writer.text(depth + 1, 'assetId', object.assetId);
    writer.text(depth + 1, 'assetVersionId', object.assetVersionId);

    writeAnimation(writer, depth + 1, object.animation);
    writeNodeList(writer, depth + 1, 'nodeBindings', object.nodeBindings);
    writeModifications(writer, depth + 1, object.modifications);
    writeLngLat(writer, depth + 1, 'gisCenter', object.gisCenter);
    writeGeometry(writer, depth + 1, object.geometry);
    writeMaterial(writer, depth + 1, object.material);

    // 未知字段兜底：未来 serializeObject 增加字段时导出仍然完整
    for (const [key, value] of Object.entries(object)) {
        if (known.has(key)) continue;
        if (key === 'geometry' || key === 'material') continue;
        writeNamedValue(writer, depth + 1, key, value);
    }

    writer.close(depth, 'object');
}

/* ------------------------------------------------------------------ *
 * 场景元数据
 * ------------------------------------------------------------------ */

const METADATA_SCALAR_KEYS = [
    'sceneId', 'name', 'description', 'cameraFar', 'lastModified',
    'objectCount', 'environmentUrl', 'isFeatured'
];
const LIGHTING_ATTRIBUTES = [
    'enabled', 'ambient', 'hemisphere', 'key', 'fill', 'head',
    'azimuth', 'elevation', 'exposure'
];
const GIS_ATTRIBUTE_KEYS = [
    'enable', 'size', 'projection', 'gridVisible', 'showBaseMap', 'baseMapUrl'
];

function writeInitialView(writer, depth, view) {
    if (!isPlainObject(view)) return;
    if (!isVector3(view.position) && !isVector3(view.target)) return;

    writer.open(depth, 'initialView');
    writeVector(writer, depth + 1, 'position', view.position);
    writeVector(writer, depth + 1, 'target', view.target);
    writer.close(depth, 'initialView');
}

function writeLightingConfig(writer, depth, config) {
    if (!isPlainObject(config)) return;
    const pairs = LIGHTING_ATTRIBUTES
        .filter((key) => config[key] !== undefined)
        .map((key) => [key, config[key]]);
    if (pairs.length === 0) return;
    writer.empty(depth, 'lightingConfig', pairs);
}

function writeGisConfig(writer, depth, config) {
    if (!isPlainObject(config)) return;

    writer.open(depth, 'gisConfig', [['enable', config.enable]]);
    writeLngLat(writer, depth + 1, 'center', config.center);
    for (const key of GIS_ATTRIBUTE_KEYS) {
        if (key === 'enable') continue;
        writer.text(depth + 1, key, config[key]);
    }
    if (isPlainObject(config.bounds)) {
        writer.empty(depth + 1, 'bounds', [
            ['minLng', config.bounds.minLng],
            ['minLat', config.bounds.minLat],
            ['maxLng', config.bounds.maxLng],
            ['maxLat', config.bounds.maxLat]
        ]);
    }
    if (isPlainObject(config.range)) {
        writer.empty(depth + 1, 'range', [
            ['length', config.range.length],
            ['width', config.range.width]
        ]);
    }
    writer.close(depth, 'gisConfig');
}

function writeDeletedSourceNodes(writer, depth, records) {
    if (!Array.isArray(records)) return;
    if (records.length === 0) {
        writer.empty(depth, 'deletedSourceNodes', [['count', 0]]);
        return;
    }
    writer.open(depth, 'deletedSourceNodes', [['count', records.length]]);
    for (const record of records) {
        writer.empty(depth + 1, 'deleted', [
            ['originObjectBid', record?.originObjectBid],
            ['assetNodeId', record?.assetNodeId]
        ]);
    }
    writer.close(depth, 'deletedSourceNodes');
}

function writeMetadata(writer, depth, metadata) {
    const source = isPlainObject(metadata) ? metadata : {};
    const known = new Set([
        ...METADATA_SCALAR_KEYS, 'initialView', 'lightingConfig', 'gisConfig', 'nodeGraph',
        'deletedSourceNodes'
    ]);

    writer.open(depth, 'metadata');
    for (const key of METADATA_SCALAR_KEYS) writer.text(depth + 1, key, source[key]);
    writeInitialView(writer, depth + 1, source.initialView);
    writeLightingConfig(writer, depth + 1, source.lightingConfig);
    writeGisConfig(writer, depth + 1, source.gisConfig);
    writeNodeList(writer, depth + 1, 'nodeGraph', source.nodeGraph);
    writeDeletedSourceNodes(writer, depth + 1, source.deletedSourceNodes);

    for (const [key, value] of Object.entries(source)) {
        if (known.has(key)) continue;
        writeNamedValue(writer, depth + 1, key, value);
    }
    writer.close(depth, 'metadata');
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/**
 * 包装成带信封信息的完整场景文档。
 *
 * @param {{ objects?: Array, metadata?: Object }} snapshot - PersistenceManager 的快照
 * @param {{ now?: number|Date }} [options] - 可注入导出时刻，便于测试
 * @returns {{format:string, formatVersion:number, generator:string, exportedAt:string, metadata:Object, objects:Array}}
 */
export function buildSceneDocument(snapshot, options = {}) {
    const now = options.now ?? Date.now();
    const exportedAt = new Date(now).toISOString();

    return {
        format: SCENE_FORMAT,
        formatVersion: SCENE_FORMAT_VERSION,
        generator: 'Meteor3D',
        exportedAt,
        metadata: isPlainObject(snapshot?.metadata) ? snapshot.metadata : {},
        objects: Array.isArray(snapshot?.objects) ? snapshot.objects : []
    };
}

/**
 * 序列化为 JSON 文本。
 *
 * @param {Object} document - buildSceneDocument 的产物
 * @param {{ pretty?: boolean }} [options] - pretty 默认 true
 * @returns {string}
 */
export function sceneDocumentToJSON(document, options = {}) {
    if (!isPlainObject(document)) {
        throw new TypeError('sceneDocumentToJSON: document 必须是对象');
    }
    if (options.pretty === false) return JSON.stringify(document);
    return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * 序列化为 XML 文本。
 *
 * @param {Object} document - buildSceneDocument 的产物
 * @param {{ trailingNewline?: boolean }} [options] - 文件末尾是否补换行，默认 true
 * @returns {string}
 */
export function sceneDocumentToXML(document, options = {}) {
    if (!isPlainObject(document)) {
        throw new TypeError('sceneDocumentToXML: document 必须是对象');
    }

    const writer = new XmlWriter();
    writer.lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    writer.open(0, 'meteor3d-scene', [
        ['format', document.format || SCENE_FORMAT],
        ['formatVersion', document.formatVersion ?? SCENE_FORMAT_VERSION],
        ['generator', document.generator],
        ['exportedAt', document.exportedAt]
    ]);

    writeMetadata(writer, 1, document.metadata);

    const objects = Array.isArray(document.objects) ? document.objects : [];
    writer.open(1, 'objects', [['count', objects.length]]);
    for (const object of objects) writeObject(writer, 2, object);
    writer.close(1, 'objects');

    writer.close(0, 'meteor3d-scene');

    const xml = writer.toString();
    return options.trailingNewline === false ? xml : `${xml}\n`;
}

const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 去掉文件名中 Windows / POSIX 都不允许的字符。 */
function sanitizeFileBase(name) {
    const cleaned = String(name ?? '')
        .replace(UNSAFE_FILENAME_CHARS, '_')
        .replace(/\s+/g, '_')
        .replace(/^[._]+/, '')
        .replace(/[._]+$/, '')
        .slice(0, 60);
    return cleaned || 'scene';
}

function formatTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(Date.now());

    const pad = (number) => String(number).padStart(2, '0');
    const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `${ymd}-${hms}`;
}

/**
 * 生成导出文件名，形如 `Meteor3D_我的场景_20261019-114500.json`。
 *
 * @param {Object} document - buildSceneDocument 的产物
 * @param {string} [extension='json']
 * @returns {string}
 */
export function buildSceneFileName(document, extension = 'json') {
    const base = sanitizeFileBase(document?.metadata?.name);
    const stamp = formatTimestamp(document?.exportedAt ?? Date.now());
    return `Meteor3D_${base}_${stamp}.${extension}`;
}

/**
 * 触发浏览器下载。仅可在浏览器环境调用。
 *
 * @param {string} content - 文件文本内容
 * @param {string} fileName - 下载文件名
 * @param {string} [mimeType='application/octet-stream']
 * @returns {void}
 */
export function downloadTextFile(content, fileName, mimeType = 'application/octet-stream') {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        throw new Error('downloadTextFile 只能在浏览器环境中调用');
    }

    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const objectUrl = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    // 立刻 revoke 在部分浏览器上会打断下载，延迟释放
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}
