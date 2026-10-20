import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { alignBottomToY, getBottomY } from '../src/utils/groundPlacement.js';

function createMesh({ size = [2, 4, 2], position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] } = {}) {
    const geometry = new THREE.BoxGeometry(...size);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.scale.set(...scale);
    return mesh;
}

const EPSILON = 1e-9;

test('原点在中心的对象，下边缘对齐到 Y=0', () => {
    // 高 4 的立方体，中心在原点时下边缘在 -2
    const mesh = createMesh({ size: [2, 4, 2], position: [0, 0, 0] });

    assert.equal(alignBottomToY(mesh, 0), true);

    const box = new THREE.Box3().setFromObject(mesh);
    assert.ok(Math.abs(box.min.y) < EPSILON, `下边缘应为 0，实际 ${box.min.y}`);
    // 高度 4 → 中心应在 Y=2
    assert.ok(Math.abs(mesh.position.y - 2) < EPSILON, `中心 Y 应为 2，实际 ${mesh.position.y}`);
});

test('只改动 Y，X / Z 保持不变', () => {
    const mesh = createMesh({ size: [1, 3, 1], position: [5, 10, -3] });

    alignBottomToY(mesh, 0);

    assert.equal(mesh.position.x, 5);
    assert.equal(mesh.position.z, -3);
    assert.ok(Math.abs(mesh.position.y - 1.5) < EPSILON);
});

test('模型原点本身就在底部时，偏移量接近于 0', () => {
    // 下边缘在 0（中心抬高半个高度）
    const mesh = createMesh({ size: [2, 2, 2], position: [0, 1, 0] });

    assert.equal(alignBottomToY(mesh, 0), true);
    assert.ok(Math.abs(mesh.position.y - 1) < EPSILON);
});

test('支持非 0 的目标高度', () => {
    const mesh = createMesh({ size: [2, 4, 2] });

    alignBottomToY(mesh, 2.5);

    assert.ok(Math.abs(getBottomY(mesh) - 2.5) < EPSILON);
});

test('旋转与缩放后仍然贴合地面', () => {
    // 立方体绕 X 旋转 45° 后包围盒变高
    const mesh = createMesh({
        size: [2, 2, 2],
        rotation: [Math.PI / 4, 0, 0],
        scale: [1.5, 1.5, 1.5]
    });

    assert.equal(alignBottomToY(mesh, 0), true);
    assert.ok(Math.abs(getBottomY(mesh)) < EPSILON);
});

test('父节点带偏移的组，下边缘按世界坐标对齐', () => {
    const root = new THREE.Group();
    const child = createMesh({ size: [1, 2, 1] });
    child.position.set(0, 5, 0); // 子节点相对父节点抬高

    const inner = new THREE.Group();
    inner.name = 'inner';
    inner.add(child);
    root.add(inner);
    root.position.set(3, 100, 4);

    assert.equal(alignBottomToY(root, 0), true);
    assert.ok(Math.abs(getBottomY(root)) < EPSILON);
    // 子节点的局部位置不应被修改
    assert.equal(child.position.y, 5);
});

test('重复调用保持幂等', () => {
    const mesh = createMesh({ size: [2, 4, 2] });

    alignBottomToY(mesh, 0);
    const first = mesh.position.y;
    alignBottomToY(mesh, 0);

    assert.ok(Math.abs(mesh.position.y - first) < EPSILON);
});

test('空对象返回 false 且不做修改', () => {
    const group = new THREE.Group();

    assert.equal(alignBottomToY(group, 0), false);
    assert.equal(group.position.y, 0);
    assert.equal(getBottomY(group), null);
});

test('非法入参返回 false', () => {
    assert.equal(alignBottomToY(null, 0), false);
    assert.equal(alignBottomToY({}, 0), false);
    assert.equal(alignBottomToY(createMesh(), Number.NaN), false);
    assert.equal(getBottomY(null), null);
});
