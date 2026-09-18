# 光年档案视觉素材

2026-09-13，用户选择第二张效果图后，内置 ImageGen 生成独立黑洞横幅。

- 原始 PNG：`black-hole-banner.png`（2172×724）。
- 发布素材：`black-hole-banner.webp`（1536×512，35,582 bytes，质量84）；尺寸与压缩仅作构建优化。
- `scripts/build-black-hole-art.mjs` 将 WebP 内嵌到 client.js 的 BANNER_IMAGE；无远程图片、API 密钥、运行时解码依赖或额外服务器路由。现有同步脚本随 client.js 一起交付。
- 当前为静态图，不运行 WebGL、着色器、持续动画；减少动画设置会同时关闭控件过渡。
- Gargantua 仅为视觉参考，未将其预览图、纹理或 shader 拷入发布包。图像不表达真实天文模拟精度。

## 生成提示词

Create only the standalone black-hole banner background from the selected desktop UI, not another UI mockup. Landscape 1536×512. Deep navy #090e19, left 52% clean negative space for editable UI; right black hole with ivory luminous layered lensing ring and pale copper accretion disk inclined about 25 degrees. Ring fits in frame; light dissipates before copy. No text, logos, controls, stars clutter, boxes, borders or rainbow nebula. Restrained detailed cinematic light. Reference: selected image exec-8e3dba13-032f-46c8-a159-e988c5419ffb.png.
