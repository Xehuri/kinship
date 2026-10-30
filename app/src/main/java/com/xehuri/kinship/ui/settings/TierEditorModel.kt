package com.xehuri.kinship.ui.settings

import com.xehuri.kinship.transport.AddressFamily
import com.xehuri.kinship.transport.Tier
import com.xehuri.kinship.transport.TierKind
import com.xehuri.kinship.transport.TierTarget
import com.xehuri.kinship.transport.TlsPolicy
import com.xehuri.kinship.transport.TransportHint
import java.util.UUID

/**
 * 由编辑器字段构造待保存的连接层，编辑已有连接层时保留其 id、order 与启用状态。
 */
internal fun buildTierForSave(
    initial: Tier?,
    nextOrder: Int,
    label: String,
    kind: TierKind,
    target: TierTarget,
    family: AddressFamily,
    tls: TlsPolicy,
    transportHint: TransportHint,
): Tier = Tier(
    id = initial?.id ?: UUID.randomUUID().toString(),
    order = initial?.order ?: nextOrder,
    kind = kind,
    transportHint = transportHint,
    target = target,
    family = family,
    tls = tls,
    enabled = initial?.enabled ?: true,
    label = label.trim(),
)
