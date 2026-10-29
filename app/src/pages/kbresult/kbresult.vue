<template>
    <div class="kb-result">
        <text class="kb-result-text">正在返回…</text>
    </div>
</template>

<script>
import { notifyKeyboardResult, abortKeyboardSession } from '../../services/store.js'

// Loli 键盘的 kbCaller 回跳页。
// 独立页面而非复用 index：框架在“页面已存在”时复用实例，
// 回跳 URL 上的参数可能被丢弃；新页面的 onLoad 能拿到完整参数。
export default {
    name: 'kbresult',
    mounted() {
        // 新建页面走 mounted（onLoad 不会转发到组件层），参数在 $page.loadOptions。
        const options = (this.$page && this.$page.loadOptions) || {}
        this.handle(options)
    },
    onNewOptions(options) {
        // 页面已存在时被回跳复用，走 onNewOptions。
        this.handle(options)
    },
    methods: {
        handle(options) {
            // 回跳参数就是用户输入的文本，绝不落盘（日志会被上传）
            let ok = false
            try { ok = notifyKeyboardResult(options) } catch (e) { /* 忽略 */ }
            if (!ok) {
                // 没有任何结果参数：按“不可用”结算，调用方回退系统键盘。
                try { abortKeyboardSession() } catch (e) { /* 忽略 */ }
            }
            setTimeout(() => {
                try { $falcon.navTo('index') } catch (e) { /* 忽略 */ }
            }, 60)
        }
    }
}
</script>

<style lang="less" scoped>
.kb-result {
    flex: 1;
    justify-content: center;
    align-items: center;
    background-color: #ffffff;
}

.kb-result-text {
    font-size: 20px;
    color: #666666;
}
</style>
