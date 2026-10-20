/**
 * 地平面放置工具
 *
 * 提供"把对象包围盒的下边缘对齐到某个世界 Y 值"的纯计算能力。
 * 常见用途：拖入模型时让它站在地面上，而不是让模型原点（pivot）落在放置点。
 *
 * 本模块只依赖 three.js，不触碰 DOM，也不依赖任何编辑器状态，便于单独测试与复用。
 */

import * as THREE from 'three';

/**
 * 让对象的包围盒下边缘对齐到指定的世界 Y 值。
 *
 * 行为说明：
 * - 只修改 `object.position.y`，X / Z 保持不变。
 * - 测量基于当前 position / rotation / scale，因此对齐后的"下边缘"是贴合当前姿态的。
 * - 对骨骼动画模型，`Box3.setFromObject` 取的是绑定姿态的几何包围盒；运行中的动画不会参与测量。
 *
 * @param {THREE.Object3D} object - 目标对象（或其根节点）
 * @param {number} [targetY=0] - 期望的下边缘世界 Y 值
 * @returns {boolean} 是否成功对齐；对象非法、包围盒为空或数值非有限时返回 false 且不做任何修改
 * @example
 * // 让模型站在 Y=0 的地面上
 * alignBottomToY(model);
 *
 * // 让模型落在抬高的平台上
 * alignBottomToY(model, 2.5);
 */
export function alignBottomToY(object, targetY = 0) {
    if (!object?.isObject3D) return false;
    if (typeof targetY !== 'number' || !Number.isFinite(targetY)) return false;

    // 对象通常还没挂进场景，父级矩阵不会自动更新，这里必须显式刷新一次，
    // 否则 Box3.setFromObject 读到的是旧的世界矩阵。
    object.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return false;

    const offset = targetY - box.min.y;
    if (!Number.isFinite(offset)) return false;

    object.position.y += offset;
    object.updateMatrixWorld(true);
    return true;
}

/**
 * 计算对象当前的包围盒下边缘世界 Y 值。
 *
 * @param {THREE.Object3D} object - 目标对象
 * @returns {number|null} 下边缘 Y 值；对象非法或包围盒为空时返回 null
 */
export function getBottomY(object) {
    if (!object?.isObject3D) return null;

    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return null;

    return box.min.y;
}
