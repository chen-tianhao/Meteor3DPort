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

    /* ---------------- /api/assets ---------------- */

    if (pathname === '/api/assets' && method === 'GET') {
        return sendJson(res, 200, { success: true, assets: [], pagination: emptyPage(1, 10) });
    }
    if (pathname.startsWith('/api/assets/') && method === 'GET') {
        return sendJson(res, 404, { success: false, message: '资产不存在（mock 后端未实现资产库）' });
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
    console.log(`[mock] 打开 http://localhost:5173/scenes 即可进入编辑器`);
    console.log('[mock] 注意：数据只存在内存中，Ctrl+C 后丢失；资产库为空，模型上传不可用。');
});
