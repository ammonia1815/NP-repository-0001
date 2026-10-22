package com.npcompanion.app

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

// User's explicit ask: photo attachment is a token-cost risk, so cap it hard
// at 5 per message - enforced here in the picker itself and again server-side
// (see MAX_ATTACHED_IMAGES in http-server.ts) since a phone could in theory
// talk to an old/different server build.
private const val MAX_ATTACHED_PHOTOS = 5

// How often to poll for turns sent from the OTHER client (desktop) while
// this screen is open. A real push channel (WebSocket/SSE) would be more
// "live", but is real infrastructure for a feature where a few seconds of
// latency to see a desktop-typed message is a total non-issue here - an
// intentional simplicity tradeoff for a solo hobby project.
private const val HISTORY_POLL_INTERVAL_MS = 4000L

// A turn just sent by this device and a turn the next poll reports back for
// the same exchange are treated as the same message (skip re-adding) if
// they match on role+text within this window - simpler than plumbing
// server-assigned turn IDs through for a personal app.
private const val DEDUP_WINDOW_MS = 10_000L

@Composable
fun ChatScreen(prefs: Prefs, onEditSettings: () -> Unit) {
    val context = LocalContext.current
    val density = LocalDensity.current
    // Re-created if baseUrl/token change (e.g. after editing settings and
    // coming back), never stale across a settings edit.
    val client = remember(prefs.baseUrl, prefs.token) { NpApiClient(prefs.baseUrl, prefs.token) }
    val audioPlayer = remember { AudioPlayer(context) }
    val avatarPlayer = remember { AvatarPlayer(context) }
    val backgroundPlayer = remember { BackgroundVideoPlayer(context) }
    DisposableEffect(Unit) {
        onDispose { audioPlayer.release() }
    }

    val scope = rememberCoroutineScope()
    val drawerState = rememberChatLogDrawerState()

    var messages by remember { mutableStateOf(listOf<ChatMessage>()) }
    var lastSeenTimestamp by remember { mutableStateOf(0L) }
    var input by remember { mutableStateOf("") }
    var isSending by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var attachedPhotos by remember { mutableStateOf(listOf<Uri>()) }
    // Measured (not hardcoded) so the drawer's bottom edge always sits flush
    // against the top of the input bar, whether or not the error line is
    // currently showing.
    var bottomBarHeightPx by remember { mutableStateOf(0) }
    // What the avatar's own bottom padding uses - measured from a separate
    // inner wrapper that does NOT carry imePadding (only the outer Column
    // does - see below), and only updated while the input field is empty.
    // RESIZE_MODE_FIT means shrinking the avatar's box shrinks the whole
    // character to keep fitting it, so this needs to stay constant against
    // BOTH things that would otherwise grow it: typing (OutlinedTextField
    // wraps to more lines) and the keyboard opening (confirmed for real,
    // twice - once for each cause: feeding the live, growing Column height
    // straight into her padding made her visibly shrink while typing a long
    // message, AND separately, once bottomBarHeightPx was fixed to correctly
    // include the keyboard's own height, THAT alone started shrinking her too
    // the instant the keyboard opened, even with an empty input). Excluding
    // imePadding from this specific measurement point is what keeps it
    // keyboard-independent; the input.isEmpty() guard is what keeps it
    // independent of typing. The now-taller/keyboard-covered input Column
    // still gets drawn on top of her (z-order, opaque background) same as
    // the drawer already does, so any growth beyond this fixed baseline
    // crops her from the bottom instead of rescaling her.
    var baselineBottomBarHeightPx by remember { mutableStateOf(0) }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_ATTACHED_PHOTOS)
    ) { uris -> attachedPhotos = uris }

    // Also serves as the initial load (first iteration runs immediately,
    // before the first delay) - no separate one-shot fetch needed.
    LaunchedEffect(Unit) {
        while (true) {
            when (val result = client.getHistory(50)) {
                is ApiResult.Success -> {
                    val newTurns = result.data.turns.filter { it.timestamp > lastSeenTimestamp }
                    for (turn in newTurns) {
                        if (turn.role != "user" && turn.role != "assistant") continue
                        val alreadyShown = messages.any {
                            it.role == turn.role && it.text == turn.text &&
                                abs(it.timestamp - turn.timestamp) < DEDUP_WINDOW_MS
                        }
                        if (!alreadyShown) {
                            messages = messages + ChatMessage(
                                role = turn.role,
                                text = turn.text,
                                source = turn.source ?: "desktop",
                                timestamp = turn.timestamp
                            )
                        }
                    }
                    if (result.data.turns.isNotEmpty()) {
                        lastSeenTimestamp = result.data.turns.maxOf { it.timestamp }
                    }
                }
                else -> { /* transient poll failure - just try again next interval */ }
            }
            delay(HISTORY_POLL_INTERVAL_MS)
        }
    }

    fun send() {
        val text = input
        val photos = attachedPhotos
        input = ""
        attachedPhotos = emptyList()
        errorText = null
        messages = messages + ChatMessage(role = "user", text = text, source = "mobile", photoCount = photos.size)
        isSending = true
        scope.launch {
            drawerState.collapse()
            // Reading + base64-encoding each photo happens right before the
            // request goes out (uriToImagePayload hops to Dispatchers.IO
            // itself), not at picker-selection time.
            val payloads = photos.mapNotNull { uriToImagePayload(context, it) }
            when (val result = client.sendMessageStreaming(text, images = payloads) { state -> avatarPlayer.requestState(state) }) {
                is ApiResult.Success -> {
                    messages = messages + ChatMessage(role = "assistant", text = result.data.reply, source = "mobile")
                    result.data.audio?.let { audioPlayer.playBase64Wav(it) }
                }
                is ApiResult.HttpError -> {
                    avatarPlayer.requestState("idle")
                    errorText = if (result.code == 401) {
                        "인증 실패. 설정에서 토큰을 다시 확인해주세요."
                    } else {
                        "오류가 발생했어요. 다시 시도해주세요."
                    }
                }
                is ApiResult.NetworkError -> {
                    avatarPlayer.requestState("idle")
                    errorText = "서버에 연결할 수 없어요. Wi-Fi/데이터 연결과 서버 주소를 확인해주세요."
                }
            }
            drawerState.expand()
            isSending = false
        }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val bottomBarHeight = with(density) { bottomBarHeightPx.toDp() }

        // Full-bleed base layer, behind everything - the avatar clip itself
        // is an opaque solid-navy-backed video (not real alpha transparency;
        // see AvatarPlayer's own history for why), so this only actually
        // shows through in the letterboxed margins RESIZE_MODE_FIT leaves
        // around the avatar, and behind the drawer/input bar before those
        // paint their own solid background.
        BackgroundVideoView(modifier = Modifier.fillMaxSize(), player = backgroundPlayer)

        // The avatar always renders at one constant size - it never shares
        // space with (or shrinks for) the drawer or input bar below; those
        // are separate overlays drawn on top of it instead, so growth just
        // crops progressively more of her from the bottom (z-order), the
        // same as the drawer expanding upward already does. Bottom padding
        // uses the FROZEN baselineBottomBarHeight (handle + single-line bar,
        // re-measured whenever the input is empty so it still tracks
        // keyboard open/closed) rather than the live bottomBarHeight, which
        // grows as the OutlinedTextField wraps to more lines - feeding that
        // live value in here used to make RESIZE_MODE_FIT rescale her
        // smaller and smaller as a message got longer, instead of just
        // covering more of her lower body. Deliberately has no imePadding
        // itself (unlike the input Column below) - MainActivity opts the
        // whole window out of the keyboard-driven pan/resize that used to
        // drag her whole body up off-screen, so this box's own base size
        // never changes directly from the keyboard; only its padding
        // (derived from the frozen baseline) and the input row below it do.
        val baselineBottomBarHeight = with(density) { baselineBottomBarHeightPx.toDp() }
        AvatarView(
            modifier = Modifier.fillMaxSize().padding(bottom = HANDLE_HEIGHT + baselineBottomBarHeight),
            avatarPlayer = avatarPlayer
        )
        ChatLogDrawer(
            messages = messages,
            state = drawerState,
            // Can grow all the way to the top of the screen (covering the
            // avatar entirely) if the user drags it all the way up, rather
            // than stopping partway - the input bar's own height is
            // subtracted so the drawer stops exactly at its top edge.
            maxExpandedHeight = maxHeight - bottomBarHeight,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = bottomBarHeight)
        )

        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                // onGloballyPositioned has to come BEFORE (outside) imePadding
                // in this chain, not after - modifiers wrap outside-in in the
                // order written, so a trailing onGloballyPositioned measures
                // the content's size BEFORE the padding modifier earlier in
                // the chain adds its inset, not the final padded size.
                // Confirmed for real: with it last, the logged size stayed
                // frozen at ~226px (just the Row's own height) for the ENTIRE
                // keyboard open/close transition, while only the reported
                // position shifted - meaning bottomBarHeightPx never actually
                // included the keyboard's height at all, so everything
                // downstream (the drawer's maxExpandedHeight) kept treating
                // keyboard-covered screen space as free/available. This outer
                // measurement IS meant to include the keyboard (the drawer
                // needs that) - the avatar's own, keyboard-EXCLUDING baseline
                // is measured separately below, on the inner wrapper that
                // doesn't carry imePadding.
                .onGloballyPositioned { bottomBarHeightPx = it.size.height }
                .fillMaxWidth()
                // The one piece of this screen that SHOULD move for the
                // keyboard - everything else (avatar, drawer) stays put now
                // that MainActivity opts the window out of auto pan/resize.
                .imePadding()
        ) {
            // This inner wrapper deliberately sits INSIDE the imePadding
            // above, not around it - a child's onGloballyPositioned reports
            // only its own content size, unaffected by how much space an
            // ancestor's padding reserves around it, so this measurement
            // never includes the keyboard no matter how tall it gets.
            Column(
                modifier = Modifier.onGloballyPositioned {
                    // isEmpty(), not isBlank() - isBlank() also matches a
                    // field full of nothing but Enter presses ("\n\n\n..."),
                    // which is exactly the tall, grown state this baseline is
                    // supposed to stay frozen against (confirmed for real:
                    // mashing Enter alone reproduced the same shrink bug,
                    // because isBlank() kept re-freezing the baseline at that
                    // already-tall height instead of only at a truly empty field).
                    if (input.isEmpty()) baselineBottomBarHeightPx = it.size.height
                }
            ) {
            errorText?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 12.dp, vertical = 4.dp)
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.background)
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box {
                    IconButton(
                        enabled = !isSending,
                        onClick = {
                            photoPickerLauncher.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        }
                    ) {
                        Icon(
                            Icons.Default.Photo,
                            contentDescription = "사진 첨부",
                            tint = if (attachedPhotos.isNotEmpty()) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onBackground
                            }
                        )
                    }
                    // "checked" indicator per the user's spec: the icon shows
                    // a small badge with the selected count once photos are
                    // picked, until the message is actually sent.
                    if (attachedPhotos.isNotEmpty()) {
                        Surface(
                            color = MaterialTheme.colorScheme.primary,
                            shape = CircleShape,
                            modifier = Modifier.align(Alignment.TopEnd).size(16.dp)
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Text(
                                    "${attachedPhotos.size}",
                                    color = Color.White,
                                    fontSize = 10.sp
                                )
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.width(4.dp))
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("메시지 입력...") },
                    enabled = !isSending
                )
                Spacer(modifier = Modifier.width(8.dp))
                Button(enabled = !isSending && input.isNotBlank(), onClick = { send() }) {
                    Text(if (isSending) "..." else "전송")
                }
            }
            }
        }

        IconButton(
            onClick = onEditSettings,
            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)
        ) {
            Icon(
                Icons.Default.Settings,
                contentDescription = "설정",
                tint = MaterialTheme.colorScheme.onBackground
            )
        }
    }
}
