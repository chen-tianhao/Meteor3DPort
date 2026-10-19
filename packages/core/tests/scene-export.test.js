import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCENE_FORMAT,
    SCENE_FORMAT_VERSION,
    SCENE_MIME_TYPES,
    buildSceneDocument,
    buildSceneFileName,
    sceneDocumentToJSON,
    sceneDocumentToXML
} from '../src/SceneExporter.js';
import { PersistenceManager } from '../src/PersistenceManager.js';

const EXPORTED_AT = Date.UTC(2026, 9, 19, 3, 44, 31);

function createSnapshot() {
    return {
        metadata: {
            sceneId: 'scene-1',
            name: '园区 & <A>',
            description: '测试场景',
            cameraFar: 1000000,
            lastModified: 1700000000000,
            objectCount: 2,
            environmentUrl: '/uploads/env.hdr',
            lightingConfig: { enabled: true, ambient: 1, exposure: 1.2 },
            gisConfig: {
                enable: true,
                center: { lng: 108.9, lat: 34.2 },
                size: 1000,
                bounds: { minLng: 108.8, minLat: 34.1, maxLng: 109, maxLat: 34.3 },
                gridVisible: false,
                showBaseMap: true,
                baseMapUrl: '/uploads/basemaps/a.png'
            },
            nodeGraph: [
                {
                    bid: 'bid_a',
                    originObjectBid: 'bid_a',
                    assetNodeId: 'an_root',
                    parentBid: null,
                    order: 0,
                    name: 'root',
                    visible: true,
                    position: { x: 0, y: 0, z: 0 },
                    rotation: { x: 0, y: 0, z: 0 },
                    scale: { x: 1, y: 1, z: 1 }
                }
            ],
            deletedSourceNodes: [{ originObjectBid: 'bid_a', assetNodeId: 'an_removed' }]
        },
        objects: [
            {
                id: 'bid_a',
                bid: 'bid_a',
                type: 'GLTFModel',
                name: '模型 "A"',
                url: '/uploads/a_compressed.glb',
                assetId: 'asset-1',
                assetVersionId: 'version-1',
                visible: true,
                position: { x: 1, y: 2, z: 3 },
                rotation: { x: 0, y: 1.57, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
                nodeBindings: [],
                animation: {
                    enabled: true,
                    playing: false,
                    clipIndex: 0,
                    clipName: '',
                    speed: 1,
                    loop: 'repeat'
                },
                modifications: {
                    an_door: {
                        visible: false,
                        position: { x: 0.5, y: 0, z: 0 },
                        material: { color: 16711680, roughness: 0.4 }
                    }
                },
                // 模拟未来 serializeObject 新增的字段，验证兜底不会丢数据
                customFlag: 42
            },
            {
                id: 'bid_b',
                bid: 'bid_b',
                type: 'BoxGeometry',
                name: '盒子',
                visible: true,
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
                geometry: { type: 'BoxGeometry', parameters: { width: 1, height: 2, depth: 3 } },
                material: { color: 16777215, roughness: 0.5, metalness: 0.5, wireframe: false }
            }
        ]
    };
}

/**
 * 一个够用的 XML 结构校验器：标签必须正确配对，标签间文本不得有未转义的 < 和 &。
 * 目的是防止导出器产出无法被外部系统解析的文件。
 */
function assertWellFormedXml(xml) {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), '缺少 XML 声明');

    const body = xml.slice(xml.indexOf('?>') + 2);
    const tagPattern = /<(\/?)([A-Za-z_][\w.\-]*)((?:\s+[^\s=>/]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;

    const stack = [];
    let cursor = 0;
    let match;

    while ((match = tagPattern.exec(body)) !== null) {
        const between = body.slice(cursor, match.index);
        assert.ok(!between.includes('<'), `标签之间存在未转义的 "<"：${between.slice(0, 40)}`);
        assert.ok(
            !/(?<!&)&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(between),
            `标签之间存在未转义的 "&"：${between.slice(0, 40)}`
        );

        cursor = tagPattern.lastIndex;

        const [, closing, name, , selfClosing] = match;
        if (selfClosing === '/') {
            assert.equal(closing, '', `自闭合标签不应带斜杠：<${name}/>`);
            continue;
        }
        if (closing === '/') {
            const expected = stack.pop();
            assert.equal(name, expected, `闭合标签不匹配：期望 </${expected}>，实际 </${name}>`);
        } else {
            stack.push(name);
        }
    }

    assert.equal(stack.length, 0, `存在未闭合的标签：${stack.join(', ')}`);
}

test('buildSceneDocument 产出带信封信息的完整文档', () => {
    const document = buildSceneDocument(createSnapshot(), { now: EXPORTED_AT });

    assert.equal(document.format, SCENE_FORMAT);
    assert.equal(document.formatVersion, SCENE_FORMAT_VERSION);
    assert.equal(document.generator, 'Meteor3D');
    assert.equal(document.exportedAt, new Date(EXPORTED_AT).toISOString());
    assert.equal(document.objects.length, 2);
    assert.equal(document.metadata.sceneId, 'scene-1');
});

test('JSON 导出与后端保存载荷同构且可被解析回来', () => {
    const document = buildSceneDocument(createSnapshot(), { now: EXPORTED_AT });
    const content = sceneDocumentToJSON(document);

    // 顶层保留 objects / metadata，可直接回灌 POST /api/scene/save
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed.objects, document.objects);
    assert.deepEqual(parsed.metadata, document.metadata);
    assert.ok(content.endsWith('\n'), '格式化输出应以换行结尾');
    assert.ok(content.includes('\n  "format"'), '默认应带缩进');
});

test('JSON 导出可以关闭格式化', () => {
    const document = buildSceneDocument(createSnapshot(), { now: EXPORTED_AT });
    const compact = sceneDocumentToJSON(document, { pretty: false });

    assert.ok(!compact.includes('\n'));
    assert.deepEqual(JSON.parse(compact), document);
});

test('XML 导出结构合法且转义正确', () => {
    const document = buildSceneDocument(createSnapshot(), { now: EXPORTED_AT });
    const xml = sceneDocumentToXML(document);

    assertWellFormedXml(xml);

    // 元数据里的 & 和尖括号必须被转义
    assert.ok(xml.includes('<name>园区 &amp; &lt;A&gt;</name>'), '文本节点转义不正确');
    // 属性里的双引号必须被转义
    assert.ok(xml.includes('name="模型 &quot;A&quot;"'), '属性转义不正确');
    // 根节点与计数
    assert.ok(xml.includes('<meteor3d-scene format="meteor3d-scene"'));
    assert.ok(xml.includes('<objects count="2">'));
});

test('XML 表达变换、节点、材质与几何参数', () => {
    const document = buildSceneDocument(createSnapshot(), { now: EXPORTED_AT });
    const xml = sceneDocumentToXML(document);

    assert.ok(xml.includes('<position x="1" y="2" z="3"/>'), '对象变换应为属性形式');
    assert.ok(xml.includes('<object type="GLTFModel"'), '对象类型应写入属性');
    assert.ok(xml.includes('<animation enabled="true" playing="false" clipIndex="0"'), '动画配置缺失');
    assert.ok(xml.includes('<modification key="an_door">'), '节点修改记录缺失');
    assert.ok(xml.includes('<material color="16711680" roughness="0.4"/>'), '修改中的材质缺失');
    assert.ok(xml.includes('<parameter name="width">1</parameter>'), '几何参数缺失');
    assert.ok(xml.includes('<lightingConfig enabled="true" ambient="1" exposure="1.2"/>'), '光照配置缺失');
    assert.ok(xml.includes('<center lng="108.9" lat="34.2"/>'), 'GIS 中心点缺失');
    assert.ok(xml.includes('<bounds minLng="108.8" minLat="34.1" maxLng="109" maxLat="34.3"/>'), 'GIS 边界缺失');
    assert.ok(xml.includes('<deleted originObjectBid="bid_a" assetNodeId="an_removed"/>'), '已删除源节点记录缺失');
});

test('XML 保留未知扩展字段，不静默丢数据', () => {
    const document = buildSceneDocument(createSnapshot(), { now: EXPORTED_AT });
    const xml = sceneDocumentToXML(document);

    assert.ok(xml.includes('<customFlag>42</customFlag>'), '未知标量字段被丢弃');
});

test('导出文件名剔除非法字符并带时间戳', () => {
    const document = buildSceneDocument(
        { metadata: { name: 'a/b:c*d?e"f<g>h|i' }, objects: [] },
        { now: EXPORTED_AT }
    );
    const fileName = buildSceneFileName(document, 'xml');

    assert.match(fileName, /^Meteor3D_/, '文件名应带产品前缀');
    assert.match(fileName, /\.xml$/, '扩展名不正确');
    assert.ok(!/[\\/:*?"<>|]/.test(fileName), `文件名仍含非法字符：${fileName}`);
});

test('导出文件名在空名称时回退为 scene', () => {
    const document = buildSceneDocument({ metadata: { name: '   ' }, objects: [] }, { now: EXPORTED_AT });
    assert.match(buildSceneFileName(document, 'json'), /^Meteor3D_scene_/);
});

/* ---------------- PersistenceManager 集成 ---------------- */

function createExporter() {
    const manager = Object.create(PersistenceManager.prototype);
    manager.sceneManager = {
        isReady: true,
        objects: [{ userData: { bid: 'bid_a' } }],
        environmentUrl: null,
        gisConfig: null,
        gridVisible: false
    };
    manager.editorStore = {
        sceneMetadata: { name: '导出测试', description: '', cameraFar: 1000000 }
    };
    manager.currentSceneId = 'scene-1';
    manager.objectMap = new Map();
    manager.serializeObject = () => ({
        id: 'bid_a',
        bid: 'bid_a',
        type: 'BoxGeometry',
        name: '盒子',
        visible: true,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        geometry: { type: 'BoxGeometry', parameters: { width: 1 } },
        material: { color: 1 }
    });
    manager.serializeSceneGraph = () => [];
    manager.serializeDeletedSourceNodes = () => [];
    return manager;
}

test('exportSceneJSON 复用保存链路的快照', () => {
    const manager = createExporter();
    const result = manager.exportSceneJSON({ now: EXPORTED_AT });

    assert.equal(result.format, 'json');
    assert.equal(result.mimeType, SCENE_MIME_TYPES.json);
    assert.match(result.fileName, /^Meteor3D_导出测试_.*\.json$/);

    const document = JSON.parse(result.content);
    assert.equal(document.metadata.sceneId, 'scene-1');
    assert.equal(document.metadata.name, '导出测试');
    assert.equal(document.metadata.objectCount, 1);
    assert.equal(document.objects.length, 1);
});

test('exportSceneXML 生成合法 XML', () => {
    const manager = createExporter();
    const result = manager.exportSceneXML({ now: EXPORTED_AT });

    assert.equal(result.format, 'xml');
    assert.equal(result.mimeType, SCENE_MIME_TYPES.xml);
    assertWellFormedXml(result.content);
    assert.ok(result.content.includes('<object type="BoxGeometry"'));
});

test('未完整加载的场景默认拒绝导出，显式允许时才输出', () => {
    const manager = createExporter();
    manager.sceneManager.isReady = false;

    assert.throws(() => manager.exportSceneJSON(), /场景尚未完整加载/);
    const result = manager.exportSceneJSON({ allowIncomplete: true });
    assert.ok(result.content.length > 0);
});

test('未知导出格式直接报错', () => {
    const manager = createExporter();
    assert.throws(() => manager.exportScene('yaml'), /不支持的导出格式/);
});
