<template>
  <div class="toolbar">
    <div class="group">
      <button @click="toggleCameraMode" :title="cameraMode === 'ghost' ? '切换到轨道模式' : '切换到幽灵模式'">
        {{ cameraMode === 'ghost' ? '轨道模式' : '幽灵模式' }}
      </button>
    </div>
    <div class="group">
      <button :class="{ active: transformMode === 'translate' }" title="移动；再次点击或按 Esc 返回选择" @click="toggleTransformMode('translate')">移动</button>
      <button :class="{ active: transformMode === 'rotate' }" title="旋转；再次点击或按 Esc 返回选择" @click="toggleTransformMode('rotate')">旋转</button>
      <button :class="{ active: transformMode === 'scale' }" title="缩放；再次点击或按 Esc 返回选择" @click="toggleTransformMode('scale')">缩放</button>
      <span class="mode-status">当前：{{ transformModeLabel }}</span>
    </div>
    <div class="group">
      <button @click="undo">撤销</button>
      <button @click="redo">重做</button>
    </div>
    <div class="group">
      <button @click="showBatchLoader = true" title="批量导入">📥 批量导入</button>
      <button v-if="!canSave" class="unlock-btn" @click="openUnlockModal" title="权限解锁">🔒 权限解锁</button>
      <button v-if="canSave" type="button" @click="save(false)" class="save-btn" :disabled="sceneDeleted">{{ sceneDeleted ? '场景已删除，保存已停止' : '💾 保存' }}</button>
    </div>

    <div class="group export-group">
      <button
        type="button"
        class="export-btn"
        :disabled="exporting"
        :title="'把当前场景导出为本地文件（JSON / XML），不影响服务器数据'"
        @click.stop="toggleExportMenu"
      >
        ⬇ 导出 <span class="caret">▾</span>
      </button>
      <div v-if="showExportMenu" class="export-menu" @click.stop>
        <button type="button" @click="exportScene('json')" title="与 /api/scene/save 请求体同构，可直接回灌">导出 JSON</button>
        <button type="button" @click="exportScene('xml')" title="同构映射的 XML，便于外部系统解析">导出 XML</button>
      </div>
    </div>
    
    <BatchLoaderDialog v-model:visible="showBatchLoader" />

    <!-- 权限解锁密码确认弹窗 -->
    <div v-if="showUnlockModal" class="modal-overlay" @click.self="closeUnlockModal">
      <div class="modal">
        <h3>权限解锁</h3>
        <p class="modal-tip">此场景为精品案例，请输入密码验证以解锁保存及自动保存权限。</p>
        <form @submit.prevent="handleUnlockSubmit">
          <div class="form-group">
            <label for="unlock-password">解锁密码</label>
            <input
              id="unlock-password"
              ref="unlockPasswordInput"
              v-model="unlockPassword"
              type="password"
              placeholder="请输入密码"
              autocomplete="off"
              @input="unlockPasswordError = ''"
            />
            <p v-if="unlockPasswordError" class="password-error">{{ unlockPasswordError }}</p>
          </div>
          <div class="modal-actions">
            <button type="button" class="cancel-btn" @click="closeUnlockModal">取消</button>
            <button type="submit" class="confirm-btn">确认解锁</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { message } from '../utils/message';
import { useEditorStore } from '../stores/editorStore';
import BatchLoaderDialog from './BatchLoaderDialog.vue';

const editorStore = useEditorStore();
const showBatchLoader = ref(false);
const showExportMenu = ref(false);
const exporting = ref(false);
const cameraMode = ref('orbit');
const transformMode = ref('select');

const showUnlockModal = ref(false);
const unlockPassword = ref('');
const unlockPasswordError = ref('');
const unlockPasswordInput = ref(null);

const isFeatured = computed(() => editorStore.sceneMetadata?.isFeatured || false);
const isUnlocked = computed(() => editorStore.isUnlocked);
const canSave = computed(() => !isFeatured.value || isUnlocked.value);
const allowPartialSave = computed(() => editorStore.allowPartialSave);
const transformModeLabel = computed(() => ({
  select: '选择',
  translate: '移动',
  rotate: '旋转',
  scale: '缩放'
})[transformMode.value] || '选择');

const openUnlockModal = () => {
  showUnlockModal.value = true;
  unlockPassword.value = '';
  unlockPasswordError.value = '';
  nextTick(() => unlockPasswordInput.value?.focus());
};

const closeUnlockModal = () => {
  showUnlockModal.value = false;
  unlockPassword.value = '';
  unlockPasswordError.value = '';
};

const handleUnlockSubmit = () => {
  if (unlockPassword.value !== '123456') {
    unlockPasswordError.value = '密码错误';
    unlockPasswordInput.value?.focus();
    return;
  }
  editorStore.isUnlocked = true;
  closeUnlockModal();
  message.success('权限解锁成功！已开启保存及自动保存权限。');
};

const toggleCameraMode = () => {
  const sceneManager = window.editor?.sceneManager;
  if (!sceneManager) return;

  const currentMode = sceneManager.getControlMode();
  const nextMode = currentMode === 'ghost' ? 'orbit' : 'ghost';

  if (sceneManager.setControlMode(nextMode)) {
    cameraMode.value = nextMode;
  }
};

const setMode = (mode) => {
  const transformManager = window.editor?.transformManager;
  if (transformManager?.setMode(mode)) {
    transformMode.value = transformManager.getMode();
  }
};

const toggleTransformMode = (mode) => {
  setMode(transformMode.value === mode ? 'select' : mode);
};

/* ---------------- 场景导出 ---------------- */

const closeExportMenu = () => {
  showExportMenu.value = false;
};

const toggleExportMenu = () => {
  if (exporting.value) return;
  showExportMenu.value = !showExportMenu.value;
};

// 点击下拉菜单以外的区域时收起菜单
const handleDocumentClick = (event) => {
  if (!showExportMenu.value) return;
  if (event.target?.closest?.('.export-group')) return;
  closeExportMenu();
};

/**
 * 导出当前场景到本地文件。
 * 导出是只读操作：场景未完整加载时仍然允许，但会明确提示内容可能不完整。
 */
const exportScene = (format) => {
  closeExportMenu();

  const persistenceManager = window.editor?.persistenceManager;
  const sceneManager = window.editor?.sceneManager;
  if (!persistenceManager) {
    message.warning('场景尚未就绪，暂时无法导出');
    return;
  }

  const allowIncomplete = !sceneManager?.isReady;
  const label = format === 'xml' ? 'XML' : 'JSON';

  exporting.value = true;
  try {
    const result = persistenceManager.downloadScene(format, { allowIncomplete });
    const objectCount = result.document?.metadata?.objectCount ?? 0;
    if (allowIncomplete) {
      message.warning(`已导出 ${label}（场景未完整加载，内容可能不完整）：${result.fileName}`, 6000);
    } else {
      message.success(`已导出 ${label}（${objectCount} 个对象）：${result.fileName}`);
    }
  } catch (error) {
    console.error('场景导出失败:', error);
    message.error(error.message || '场景导出失败');
  } finally {
    exporting.value = false;
  }
};

const onKeyDown = (event) => {
  if (event.key === 'Escape' && showExportMenu.value) {
    closeExportMenu();
    return;
  }
  if (event.key === 'Escape' && transformMode.value !== 'select') {
    setMode('select');
  }
};

const onTransformModeChanged = (event) => {
  transformMode.value = event.detail?.mode || 'select';
};

const undo = () => {
  if (window.editor && window.editor.historyManager) {
    window.editor.historyManager.undo();
  }
};

const redo = () => {
  if (window.editor && window.editor.historyManager) {
    window.editor.historyManager.redo();
  }
};

const isSaving = ref(false);
const sceneDeleted = ref(false);

const save = async (isAutoSave = false) => {
  if (!canSave.value || isSaving.value || sceneDeleted.value) return;

  const sceneManager = window.editor?.sceneManager;
  const persistenceManager = window.editor?.persistenceManager;

  if (!sceneManager?.isReady && !allowPartialSave.value) {
    if (!isAutoSave) {
      message.warning('场景尚未完整加载，当前不能保存');
    }
    return;
  }

  if (!persistenceManager) return;

  isSaving.value = true;
  try {
    await persistenceManager.saveScene({
      allowIncomplete: allowPartialSave.value
    });
    if (!isAutoSave) {
      message.success('场景已保存！');
    }
  } catch (error) {
    console.error(isAutoSave ? '自动保存失败:' : '场景保存失败:', error);
    if (error.code === 'SCENE_NOT_FOUND') {
      sceneDeleted.value = true;
      clearInterval(autoSaveTimer);
      autoSaveTimer = null;
      message.warning('此场景已删除或不存在，自动保存已停止，请返回场景管理。');
      return;
    }
    if (!isAutoSave) {
      message.warning(error.message || '场景保存失败');
    }
  } finally {
    isSaving.value = false;
  }
};

let autoSaveTimer = null;

onMounted(() => {
  window.addEventListener('transform-mode-changed', onTransformModeChanged);
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', handleDocumentClick);
  transformMode.value = window.editor?.transformManager?.getMode() || 'select';

  autoSaveTimer = setInterval(() => {
    const sceneManager = window.editor?.sceneManager;
    if (!canSave.value || (!sceneManager?.isReady && !allowPartialSave.value)) return;
    void save(true);
  }, 10000);
});

onUnmounted(() => {
  window.removeEventListener('transform-mode-changed', onTransformModeChanged);
  window.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('click', handleDocumentClick);
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
  }
});
</script>

<style scoped>
.toolbar {
  padding: 10px;
  background: #333;
  display: flex;
  gap: 20px;
}

.group {
  display: flex;
  align-items: center;
  gap: 5px;
}

button {
  padding: 5px 10px;
  background: #555;
  color: white;
  border: none;
  cursor: pointer;
}

button:hover {
  background: #666;
}

button.active {
  background: #0066cc;
}

.mode-status {
  margin-left: 4px;
  color: #aaa;
  font-size: 12px;
  white-space: nowrap;
}

.save-btn {
  background: #0066cc;
}

.save-btn:hover {
  background: #0052a3;
}

.unlock-btn {
  background: #e6a23c;
  color: #1a1a1a;
  font-weight: bold;
}

.unlock-btn:hover {
  background: #cf9236;
}

/* ---------- 导出下拉菜单 ---------- */

.export-group {
  position: relative;
}

.export-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.export-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.caret {
  font-size: 10px;
  line-height: 1;
}

.export-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 30;
  min-width: 132px;
  padding: 4px;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.export-menu button {
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  color: #ddd;
  text-align: left;
  border-radius: 3px;
  white-space: nowrap;
}

.export-menu button:hover {
  background: #0066cc;
  color: #fff;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: #2a2a2a;
  padding: 30px;
  border-radius: 8px;
  width: 400px;
  color: white;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.modal h3 {
  margin: 0 0 15px 0;
  font-size: 20px;
}

.modal-tip {
  margin: 0 0 20px 0;
  color: #aaa;
  font-size: 14px;
  line-height: 1.5;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  color: #aaa;
  font-size: 14px;
}

.form-group input {
  width: 100%;
  padding: 10px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: white;
  font-size: 14px;
  box-sizing: border-box;
}

.form-group input:focus {
  border-color: #0066cc;
  outline: none;
}

.password-error {
  margin: 8px 0 0;
  color: #ff5f5f;
  font-size: 13px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.cancel-btn,
.confirm-btn {
  padding: 8px 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.cancel-btn {
  background: transparent;
  color: #aaa;
}

.cancel-btn:hover {
  color: white;
}

.confirm-btn {
  background: #0066cc;
  color: white;
}

.confirm-btn:hover {
  background: #0052a3;
}
</style>
