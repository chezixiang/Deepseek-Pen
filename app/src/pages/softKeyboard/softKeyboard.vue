<template>
    <div class="kb-page">
        <text class="kb-title">演示软键盘</text>
        <text class="kb-hint">在真实词典笔上此处为全键盘+拼音候选页</text>
        <text class="kb-value">{{ text }}</text>
        <div class="kb-row">
            <text class="kb-btn" @click="append('A')">A</text>
            <text class="kb-btn" @click="append('B')">B</text>
            <text class="kb-btn" @click="append('C')">C</text>
        </div>
        <div class="kb-row">
            <text class="kb-btn" @click="close">完成</text>
        </div>
    </div>
</template>

<script>
import { EVENT_SOFT_KEYBOARD } from '@dictpen/core'

export default {
    name: 'softKeyboard',
    data() {
        return {
            text: ''
        }
    },
    mounted() {
        this.text = (this.$page.loadOptions && this.$page.loadOptions.data) || ''
    },
    methods: {
        append(ch) {
            this.text += ch
            this.$forceUpdate()
        },
        close() {
            // 与 openSoftKeyboard 约定一致：关闭时触发 softKeyboard 事件回传全文
            $falcon.trigger(EVENT_SOFT_KEYBOARD, this.text)
            this.$page.finish()
        }
    }
}
</script>

<style lang="less" scoped>
.kb-page {
    flex: 1;
    justify-content: center;
    align-items: center;
}

.kb-title {
    font-size: 28px;
}

.kb-hint {
    font-size: 16px;
    color: #888888;
    margin: 8px 0;
}

.kb-value {
    font-size: 32px;
    min-height: 40px;
    margin-bottom: 20px;
}

.kb-row {
    flex-direction: row;
}

.kb-btn {
    font-size: 24px;
    color: #ffffff;
    background-color: #1a73e8;
    text-align: center;
    margin: 4px;
    padding: 8px 16px;
    border-radius: 6px;
}
</style>
