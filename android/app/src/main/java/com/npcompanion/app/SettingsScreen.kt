package com.npcompanion.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Mirrors the desktop avatar's own provider-menu icons exactly (see
// avatar.ts's PROVIDER_ICONS) so the same model always reads as the same
// symbol regardless of which client the user is looking at.
private val PROVIDER_ICONS = mapOf(
    "gemini" to "⚡",
    "gemini-fast" to "💨",
    "claude" to "🧠",
    "local" to "🦙"
)
private val PROVIDER_LABELS = mapOf(
    "gemini" to "Gemini",
    "gemini-fast" to "Gemini 고속",
    "claude" to "Claude",
    "local" to "로컬"
)

// How often to re-check /api/tts-state while sitting in "starting" - the
// toggle endpoint itself returns instantly (see http-server.ts), so this
// polling is what actually reveals when the ~7s engine boot finishes.
private const val TTS_STATE_POLL_MS = 1200L

// A plain scrollable list of rows (not a fixed layout) since more settings
// are expected to be added below these two over time - each new one is just
// another SettingsRow/SettingsToggleRow in the Column, no restructuring
// needed. "연결" (server address/token) used to be what the gear icon opened
// directly; it's now one row among others here, navigating to that same
// screen (SetupScreen) via onOpenConnection.
@Composable
fun SettingsScreen(
    prefs: Prefs,
    onBack: () -> Unit,
    onOpenConnection: () -> Unit,
    onOpenHealthRecords: () -> Unit,
    onOpenChatHistory: () -> Unit,
    onOpenRecordNote: () -> Unit,
    onOpenMemoNote: () -> Unit
) {
    // This mirrors the desktop tray's own TTS engine - the same single
    // GPT-SoVITS process every connected client shares - not a per-device
    // mute, so its state comes from the server rather than a local pref.
    val client = remember(prefs.baseUrl, prefs.token) { NpApiClient(prefs.baseUrl, prefs.token) }
    val scope = rememberCoroutineScope()
    var ttsState by remember { mutableStateOf<String?>(null) }
    var provider by remember { mutableStateOf<String?>(null) }
    // Starts already populated with every known provider (not emptyList())
    // so ProviderPickerRow renders its full row of icons on the very first
    // frame - confirmed for real that starting empty made the icon row
    // render at zero height until the /api/provider response landed
    // (~0.5s), then snap in and shove every row below it down. Only the
    // *selected* highlight still waits on the real fetch; the icons/labels
    // themselves are static and known at compile time regardless of server
    // state, so there's no reason they should wait too.
    var providerOptions by remember { mutableStateOf(PROVIDER_ICONS.keys.toList()) }

    LaunchedEffect(client) {
        // Run both requests concurrently instead of one after another - this
        // screen doesn't need the TTS result before starting the provider
        // request, so awaiting them sequentially was just adding needless
        // latency to how long the picker's selection stayed unhighlighted.
        val ttsDeferred = async { client.getTtsState() }
        val providerDeferred = async { client.getProvider() }

        when (val result = ttsDeferred.await()) {
            is ApiResult.Success -> ttsState = result.data.state
            else -> ttsState = null
        }
        when (val result = providerDeferred.await()) {
            is ApiResult.Success -> {
                provider = result.data.provider
                providerOptions = result.data.options
            }
            else -> { /* leave the static default list; current stays null so nothing shows selected */ }
        }
    }

    // Keeps re-checking while "starting" so the switch actually shows that
    // transitional state finishing, instead of only ever seeing the state
    // right before a tap and the state a while after.
    LaunchedEffect(ttsState) {
        if (ttsState != "starting") return@LaunchedEffect
        while (true) {
            delay(TTS_STATE_POLL_MS)
            when (val result = client.getTtsState()) {
                is ApiResult.Success -> {
                    ttsState = result.data.state
                    if (result.data.state != "starting") break
                }
                else -> break
            }
        }
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "뒤로",
                    tint = MaterialTheme.colorScheme.onBackground
                )
            }
            Text(
                "설정",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 8.dp)
            )
        }
        HorizontalDivider()

        Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
            SettingsRow(label = "연결", description = "서버 주소 및 토큰 설정", onClick = onOpenConnection)
            HorizontalDivider()
            SettingsToggleRow(
                label = "컴퓨터 음성 (TTS)",
                description = when (ttsState) {
                    "starting" -> "켜는 중..."
                    null -> "서버에 연결할 수 없어요"
                    else -> "엔피의 음성 합성 엔진을 켜고 끕니다"
                },
                checked = ttsState == "on" || ttsState == "starting",
                enabled = ttsState != null && ttsState != "starting",
                starting = ttsState == "starting",
                onCheckedChange = {
                    scope.launch {
                        when (val result = client.toggleTts()) {
                            is ApiResult.Success -> ttsState = result.data.state
                            else -> { /* leave ttsState as-is; switch just snaps back */ }
                        }
                    }
                }
            )
            HorizontalDivider()
            ProviderPickerRow(
                current = provider,
                options = providerOptions,
                onSelect = { name ->
                    val previous = provider
                    provider = name // optimistic - snaps back below on failure
                    scope.launch {
                        when (val result = client.setProvider(name)) {
                            is ApiResult.Success -> provider = result.data.provider
                            else -> provider = previous
                        }
                    }
                }
            )
            HorizontalDivider()
            SettingsRow(label = "건강관리", description = "근무·식단·운동·수면 기록 조회", onClick = onOpenHealthRecords)
            HorizontalDivider()
            SettingsRow(label = "이전 대화 검색", description = "날짜별로 지난 대화 기록 조회", onClick = onOpenChatHistory)
            HorizontalDivider()
            SettingsRow(label = "엔피 기록", description = "엔피가 기록해둔 내용 (엔피가 조회·수정 가능)", onClick = onOpenRecordNote)
            HorizontalDivider()
            SettingsRow(label = "내 메모", description = "내가 적어두는 메모 (엔피는 조회만 가능)", onClick = onOpenMemoNote)
            HorizontalDivider()
        }
    }
}

@Composable
private fun SettingsRow(label: String, description: String? = null, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            description?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Icon(
            Icons.Default.ChevronRight,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun SettingsToggleRow(
    label: String,
    description: String? = null,
    checked: Boolean,
    enabled: Boolean = true,
    starting: Boolean = false,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            description?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Switch(
            checked = checked,
            enabled = enabled,
            onCheckedChange = onCheckedChange,
            // A spinner riding the (already-flipped-on) thumb makes "off /
            // starting / on" three genuinely distinct looks: off position,
            // on position + spinner + disabled dimming, on position alone.
            thumbContent = if (starting) {
                {
                    CircularProgressIndicator(
                        modifier = Modifier.size(SwitchDefaults.IconSize),
                        strokeWidth = 2.dp
                    )
                }
            } else null
        )
    }
}

// Mirrors the desktop avatar's own provider-menu (icon buttons, explicit
// selection rather than a cycle) - see avatar.ts's #provider-menu. `current`
// null (server unreachable, or not yet loaded) renders every option
// unhighlighted rather than guessing one.
@Composable
private fun ProviderPickerRow(current: String?, options: List<String>, onSelect: (String) -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Text("응답 모델", style = MaterialTheme.typography.bodyLarge)
        Text(
            "엔피가 어느 모델로 응답할지 선택합니다 (데스크톱과 공유됨)",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // options comes from the server (/api/provider), so a 5th
            // provider added later shows up here with no app update needed -
            // falls back to "?" only for a name this build has no icon for.
            for (name in options) {
                val active = name == current
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Row(
                        modifier = Modifier
                            .size(44.dp)
                            .clip(CircleShape)
                            .background(if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
                            .clickable { onSelect(name) },
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(PROVIDER_ICONS[name] ?: "?", style = MaterialTheme.typography.titleMedium)
                    }
                    Text(
                        PROVIDER_LABELS[name] ?: name,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}
