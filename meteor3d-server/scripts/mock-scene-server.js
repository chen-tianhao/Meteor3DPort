/**
 * 仅用于本地验证的 mock 后端（不连接 MongoDB / Redis）。
 *
 * 目的：让场景编辑器能在没有数据库的机器上启动，从而验证编辑器本身的功能
 * （尤其是"场景导出 JSON / XML"）。它只实现编辑器启动和保存所必需的最少接口，
 * 数据全部放在内存里，进程退出即丢失。
 *
 * 用法：
 *   node meteor3d-server/scripts/mock-scene-server.js
 *   node meteor3d-server/scripts/mock-scene-server.js --port 3001
 *
 * 然后另开终端启动前端：
 *   pnpm dev:scene
 */

const http = require('http');

const PORT = (() => {
    const index = process.argv.indexOf('--port');
    const value = index >= 0 ? Number(process.argv[index + 1]) : Number(process.env.MOCK_PORT);
    return Number.isFinite(value) && value > 0 ? value : 3001;
})();

/* ------------------------------------------------------------------ *
 * 内存数据
 * ------------------------------------------------------------------ */

const DEMO_SCENE_ID = 'demo-scene';

/** 造一个"打开就能看见东西"的示例场景，方便直接验证导出内容。 */
function createDemoScene() {
    const now = Date.now();
    const scene = {
        sceneId: DEMO_SCENE_ID,
        name: '导出验证场景',
        description: '由 mock 后端提供，用于验证场景导出功能',
        thumbnail: null,
        isFeatured: false,
        environmentUrl: null,
        cameraFar: 1000000,
        initialView: {
            position: { x: 6, y: 5, z: 8 },
            target: { x: 0, y: 0.5, z: 0 }
        },
        lightingConfig: { enabled: true, ambient: 1, hemisphere: 1, key: 1, fill: 0.5, head: 0, azimuth: 45, elevation: 45, exposure: 1 },
        gisConfig: null,
        nodeGraph: [],
        deletedSourceNodes: [],
        lastModified: now,
        objectCount: 3
    };

    const objects = [
        {
            id: 'bid_demo_box',
            bid: 'bid_demo_box',
            type: 'BoxGeometry',
            name: '立方体',
            visible: true,
            position: { x: 0, y: 0.5, z: 0 },
            rotation: { x: 0, y: 0.6, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            geometry: {
                type: 'BoxGeometry',
                parameters: { width: 1, height: 1, depth: 1, widthSegments: 1, heightSegments: 1, depthSegments: 1 }
            },
            material: {
                color: 65280, roughness: 0.5, metalness: 0.5, emissive: 0, emissiveIntensity: 1,
                opacity: 1, alphaTest: 0, blending: 1, side: 0, transparent: false,
                depthTest: true, depthWrite: true, vertexColors: false, wireframe: false, flatShading: false
            }
        },
        {
            id: 'bid_demo_sphere',
            bid: 'bid_demo_sphere',
            type: 'SphereGeometry',
            name: '球体',
            visible: true,
            position: { x: 2.5, y: 0.5, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            geometry: {
                type: 'SphereGeometry',
                parameters: { radius: 0.5, widthSegments: 32, heightSegments: 32 }
            },
            material: {
                color: 16711680, roughness: 0.5, metalness: 0.5, emissive: 0, emissiveIntensity: 1,
                opacity: 1, alphaTest: 0, blending: 1, side: 0, transparent: false,
                depthTest: true, depthWrite: true, vertexColors: false, wireframe: false, flatShading: false
            }
        },
        {
            id: 'bid_demo_plane',
            bid: 'bid_demo_plane',
            type: 'PlaneGeometry',
            name: '地面',
            visible: true,
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: -Math.PI / 2, y: 0, z: 0 },
            scale: { x: 10, y: 10, z: 1 },
            geometry: {
                type: 'PlaneGeometry',
                parameters: { width: 1, height: 1, widthSegments: 1, heightSegments: 1 }
            },
            material: {
                color: 13421772, roughness: 0.5, metalness: 0.5, emissive: 0, emissiveIntensity: 1,
                opacity: 1, alphaTest: 0, blending: 1, side: 2, transparent: false,
                depthTest: true, depthWrite: true, vertexColors: false, wireframe: false, flatShading: false
            }
        }
    ];

    return { scene, objects };
}

/** sceneId -> { scene, objects } */
const store = new Map();
{
    const demo = createDemoScene();
    store.set(DEMO_SCENE_ID, demo);
}

let idCounter = 0;

/* ------------------------------------------------------------------ *
 * 演示模型（一个真实的 GLB，方便验证"地平面放置"等拖拽行为）
 * ------------------------------------------------------------------ */

const DEMO_MODEL_URL = '/uploads/models/demo-box.glb';

/**
 * 手工拼一个最小可用的 GLB：一个带法线的立方体，原点在几何中心。
 * 因为原点在中心，关闭"地平面放置"时它会被拖放点从中间穿过（埋一半），
 * 打开后应当整体贴到 Y=0 上——两者的视觉差别非常直观。
 *
 * @param {{width?:number,height?:number,depth?:number}} size
 * @returns {Buffer}
 */
function buildDemoBoxGlb({ width = 1.2, height = 2.5, depth = 1.2 } = {}) {
    const hx = width / 2;
    const hy = height / 2;
    const hz = depth / 2;

    // 六个面，每个面 4 个顶点 + 一个统一法线；材料设为双面，绕序不影响可见性。
    const faces = [
        { n: [1, 0, 0], c: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
        { n: [-1, 0, 0], c: [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
        { n: [0, 1, 0], c: [[-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]] },
        { n: [0, -1, 0], c: [[-hx, -hy, hz], [hx, -hy, hz], [hx, -hy, -hz], [-hx, -hy, -hz]] },
        { n: [0, 0, 1], c: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
        { n: [0, 0, -1], c: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] }
    ];

    const positions = [];
    const normals = [];
    const indices = [];

    for (const face of faces) {
        const base = positions.length / 3;
        for (const corner of face.c) {
            positions.push(corner[0], corner[1], corner[2]);
            normals.push(face.n[0], face.n[1], face.n[2]);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const positionArray = new Float32Array(positions);
    const normalArray = new Float32Array(normals);
    const indexArray = new Uint16Array(indices);

    const positionBytes = Buffer.from(positionArray.buffer.slice(0));
    const normalBytes = Buffer.from(normalArray.buffer.slice(0));
    const indexBytes = Buffer.from(indexArray.buffer.slice(0));

    const rawBinLength = positionBytes.length + normalBytes.length + indexBytes.length;
    const binPadding = (4 - (rawBinLength % 4)) % 4;
    const binBuffer = Buffer.concat([positionBytes, normalBytes, indexBytes, Buffer.alloc(binPadding)]);

    const gltf = {
        asset: { version: '2.0', generator: 'Meteor3D mock backend' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'demo-box' }],
        meshes: [{
            name: 'demo-box',
            primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }]
        }],
        materials: [{
            name: 'demo-material',
            doubleSided: true,
            pbrMetallicRoughness: {
                baseColorFactor: [0.36, 0.72, 1, 1],
                metallicFactor: 0.1,
                roughnessFactor: 0.5
            }
        }],
        buffers: [{ byteLength: binBuffer.length }],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
            { buffer: 0, byteOffset: positionBytes.length, byteLength: normalBytes.length, target: 34962 },
            {
                buffer: 0,
                byteOffset: positionBytes.length + normalBytes.length,
                byteLength: indexBytes.length,
                target: 34963
            }
        ],
        accessors: [
            {
                bufferView: 0,
                componentType: 5126,
                count: positionArray.length / 3,
                type: 'VEC3',
                min: [-hx, -hy, -hz],
                max: [hx, hy, hz]
            },
            { bufferView: 1, componentType: 5126, count: normalArray.length / 3, type: 'VEC3' },
            { bufferView: 2, componentType: 5123, count: indexArray.length, type: 'SCALAR' }
        ]
    };

    let jsonBuffer = Buffer.from(JSON.stringify(gltf), 'utf8');
    const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
    if (jsonPadding > 0) jsonBuffer = Buffer.concat([jsonBuffer, Buffer.alloc(jsonPadding, 0x20)]);

    const totalLength = 12 + 8 + jsonBuffer.length + 8 + binBuffer.length;

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); // 'glTF'
    header.writeUInt32LE(2, 4);          // 版本
    header.writeUInt32LE(totalLength, 8);

    const jsonChunkHeader = Buffer.alloc(8);
    jsonChunkHeader.writeUInt32LE(jsonBuffer.length, 0);
    jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

    const binChunkHeader = Buffer.alloc(8);
    binChunkHeader.writeUInt32LE(binBuffer.length, 0);
    binChunkHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

    return Buffer.concat([header, jsonChunkHeader, jsonBuffer, binChunkHeader, binBuffer]);
}

const demoBoxGlb = buildDemoBoxGlb();

/** 与 scene-editor 的 getCompressedAssetUrl 解析规则对齐：ready + processedFiles.compressed。 */
const DEMO_MODEL_ASSET = {
    _id: 'mock-model-1',
    name: '演示模型（立方体）',
    originalName: 'demo-box.glb',
    type: 'model',
    format: 'glb',
    filePath: 'uploads/models/demo-box.glb',
    fileSize: demoBoxGlb.length,
    url: DEMO_MODEL_URL,
    thumbnail: null,
    cloudUrls: {},
    assetVersionId: 'mock-model-v1',
    sourceType: 'upload',
    processingStatus: 'ready',
    processedFiles: { compressed: DEMO_MODEL_URL },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
};

/* ------------------------------------------------------------------ *
 * HTTP 辅助
 * ------------------------------------------------------------------ */

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 50 * 1024 * 1024) {
                reject(new Error('请求体超过 50MB'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(new Error(`请求体不是合法 JSON: ${error.message}`));
            }
        });
        req.on('error', reject);
    });
}

function emptyPage(page = 1, pageSize = 12) {
    return { page, pageSize, total: 0, totalPages: 0 };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 健康检查
    if (pathname === '/' || pathname === '/health') {
        return sendJson(res, 200, { success: true, message: 'Meteor3D mock 后端运行中', mode: 'mock' });
    }

    /* ---------------- /api/scene ---------------- */

    if (pathname === '/api/scene/list' && method === 'GET') {
        const scenes = [...store.values()]
            .map((entry) => entry.scene)
            .sort((a, b) => b.lastModified - a.lastModified);
        return sendJson(res, 200, {
            success: true,
            scenes,
            pagination: { page: 1, pageSize: 12, total: scenes.length, totalPages: 1 }
        });
    }

    if (pathname === '/api/scene/create' && method === 'POST') {
        const body = await readBody(req);
        const sceneId = `mock-scene-${++idCounter}`;
        const entry = {
            scene: {
                sceneId,
                name: body.name || '未命名场景',
                description: body.description || '',
                thumbnail: null,
                isFeatured: false,
                environmentUrl: null,
                cameraFar: 1000000,
                initialView: null,
                lightingConfig: null,
                gisConfig: null,
                nodeGraph: [],
                deletedSourceNodes: [],
                lastModified: Date.now(),
                objectCount: 0
            },
            objects: []
        };
        store.set(sceneId, entry);
        return sendJson(res, 201, { success: true, message: '场景创建成功', scene: entry.scene });
    }

    if (pathname === '/api/scene/load' && method === 'GET') {
        const sceneId = url.searchParams.get('sceneId');
        const entry = store.get(sceneId);
        if (!entry) {
            return sendJson(res, 404, { success: false, message: '场景不存在' });
        }
        return sendJson(res, 200, { success: true, objects: entry.objects, metadata: entry.scene });
    }

    if (pathname === '/api/scene/save' && method === 'POST') {
        const body = await readBody(req);
        const sceneId = body?.metadata?.sceneId;
        const entry = store.get(sceneId);
        if (!entry) {
            return sendJson(res, 404, {
                success: false,
                code: 'SCENE_NOT_FOUND',
                message: '场景已删除或不存在，无法保存'
            });
        }
        entry.objects = Array.isArray(body.objects) ? body.objects : [];
        Object.assign(entry.scene, body.metadata, {
            objectCount: entry.objects.length,
            lastModified: Date.now()
        });
        console.log(`[mock] 已保存场景 ${sceneId}（${entry.objects.length} 个对象）`);
        return sendJson(res, 200, { success: true, message: '场景保存成功', objectCount: entry.objects.length });
    }

    const sceneAction = pathname.match(/^\/api\/scene\/([^/]+)\/(featured|initial-view|thumbnail)$/);
    if (sceneAction && method === 'PATCH') {
        const entry = store.get(sceneAction[1]);
        if (!entry) return sendJson(res, 404, { success: false, message: '场景不存在' });
        const body = await readBody(req);
        if (sceneAction[2] === 'featured') entry.scene.isFeatured = body.isFeatured === true;
        if (sceneAction[2] === 'initial-view') entry.scene.initialView = { position: body.position, target: body.target };
        return sendJson(res, 200, { success: true, scene: entry.scene });
    }
    if (sceneAction && method === 'POST') {
        const entry = store.get(sceneAction[1]);
        if (!entry) return sendJson(res, 404, { success: false, message: '场景不存在' });
        return sendJson(res, 200, { success: true, thumbnail: null });
    }

    if (method === 'DELETE' && /^\/api\/scene\/[^/]+$/.test(pathname)) {
        const sceneId = pathname.split('/').pop();
        store.delete(sceneId);
        return sendJson(res, 200, { success: true, message: '场景删除成功' });
    }

    /* ---------------- 演示模型文件 ---------------- */

    if (pathname === DEMO_MODEL_URL && method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'model/gltf-binary',
            'Content-Length': demoBoxGlb.length,
            'Cache-Control': 'no-store'
        });
        res.end(demoBoxGlb);
        return;
    }

    /* ---------------- /api/assets ---------------- */

    if (pathname === '/api/assets' && method === 'GET') {
        const type = url.searchParams.get('type');
        const assets = !type || type === 'model' ? [DEMO_MODEL_ASSET] : [];
        return sendJson(res, 200, {
            success: true,
            assets,
            pagination: assets.length > 0
                ? { page: 1, pageSize: 10, total: assets.length, totalPages: 1 }
                : emptyPage(1, 10)
        });
    }
    if (pathname.startsWith('/api/assets/') && method === 'GET') {
        return sendJson(res, 404, { success: false, message: '资产不存在（mock 后端只提供演示模型）' });
    }

    /* ---------------- 其它 ---------------- */

    return sendJson(res, 404, {
        success: false,
        message: `mock 后端未实现该接口: ${method} ${pathname}`
    });
}

const server = http.createServer((req, res) => {
    setCors(res);
    handle(req, res).catch((error) => {
        console.error('[mock] 处理请求失败:', error);
        if (!res.headersSent) {
            sendJson(res, 500, { success: false, message: error.message });
        } else {
            res.end();
        }
    });
});

server.listen(PORT, () => {
    console.log(`[mock] Meteor3D mock 后端已启动: http://localhost:${PORT}`);
    console.log(`[mock] 示例场景 ID: ${DEMO_SCENE_ID}`);
    console.log(`[mock] 演示模型: ${DEMO_MODEL_ASSET.name} -> ${DEMO_MODEL_URL} (${demoBoxGlb.length} 字节)`);
    console.log(`[mock] 打开 http://localhost:5173/scenes 即可进入编辑器`);
    console.log('[mock] 注意：数据只存在内存中，Ctrl+C 后丢失；除演示模型外资产库为空，上传不可用。');
});
