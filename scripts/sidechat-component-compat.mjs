const oldReference = '_deepseek_ai_dsh_client_ui_primitives.IconSendOutline16'
const newReference = '_deepseek_ai_dsh_client_ui_primitives.IconSendOutline14'
const oldAnchor = `${oldReference}, {}`
const newAnchor = `${newReference}, { size: 16 }`

const count = (source, text) => source.split(text).length - 1

/** Convert the prebuilt side-chat send icon without changing its 16px size.
 * No I/O: the caller owns parsing, writing and activation of the result.
 * Reject drift, duplicate references and partially converted bundles.
 * @param {string} source
 * @returns {string}
 */
export function transformSidechatComponentCompat(source, target) {
  if (typeof source !== 'string') throw new TypeError('Sidechat component source must be a string')
  target ??= source.includes('_deepseek_ai_dsh_client_ui_primitives.IconSendOutlineRegular') ? 'IconSendOutlineRegular' : 'IconSendOutline14'
  if (!['IconSendOutline14', 'IconSendOutlineRegular'].includes(target)) throw new Error('Unsupported sidechat icon target')
  if (target === 'IconSendOutlineRegular') {
    const regular = '_deepseek_ai_dsh_client_ui_primitives.IconSendOutlineRegular'
    const regularAnchor = `${regular}, { size: 16 }`
    if (count(source, regular)) {
      if (count(source, regular) !== 1 || count(source, regularAnchor) !== 1 || count(source, oldReference) || count(source, newReference)) throw new Error('Sidechat send icon anchor changed or is not unique; review the client bundle')
      return source
    }
    return transformSidechatComponentCompat(source).replace(newAnchor, regularAnchor)
  }
  const oldCount = count(source, oldReference)
  const newCount = count(source, newReference)
  if (oldCount === 0 && newCount === 1 && count(source, newAnchor) === 1) return source
  if (oldCount !== 1 || newCount !== 0 || count(source, oldAnchor) !== 1) {
    throw new Error('Sidechat send icon anchor changed or is not unique; review the client bundle')
  }
  return source.replace(oldAnchor, newAnchor)
}
