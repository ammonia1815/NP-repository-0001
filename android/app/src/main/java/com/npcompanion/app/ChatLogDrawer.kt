package com.npcompanion.app

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// role: "user" | "assistant". source: "desktop" | "mobile" - which client
// this exchange was conducted from (see StoredTurn.source on the server).
// timestamp is used to de-duplicate this device's own just-sent messages
// against the next history poll picking up the same turn from the server.
// photoCount is purely a local display hint (how many photos were attached
// to this send) - it isn't round-tripped through history polling.
data class ChatMessage(
    val role: String,
    val text: String,
    val source: String = "mobile",
    val timestamp: Long = System.currentTimeMillis(),
    val photoCount: Int = 0
)

// 28dp was too small a touch target to reliably grab with a thumb; 44dp is
// close to Android's recommended 48dp minimum while staying visually slim.
val HANDLE_HEIGHT = 44.dp

// Drives the drawer's open amount as a single 0f (collapsed, handle only) to
// 1f (fully expanded) value. A plain Animatable + manual drag handling was
// chosen over Foundation's AnchoredDraggableState/BottomSheetScaffold: the
// sheet needs to sit directly above the always-bottom-most input row rather
// than anchoring to the screen's physical bottom edge, which fights how
// BottomSheetScaffold is meant to be used - this hand-rolled version reaches
// the exact same collapsed/expanded/drag-to-reveal behavior with simpler,
// long-stable APIs.
class ChatLogDrawerState {
    val heightFraction = Animatable(0f)

    suspend fun expand() = heightFraction.animateTo(1f, tween(durationMillis = 220, easing = FastOutSlowInEasing))
    suspend fun collapse() = heightFraction.animateTo(0f, tween(durationMillis = 220, easing = FastOutSlowInEasing))
    suspend fun toggle() = if (heightFraction.value > 0.5f) collapse() else expand()
}

@Composable
fun rememberChatLogDrawerState(): ChatLogDrawerState = remember { ChatLogDrawerState() }

// maxExpandedHeight: how tall the drawer gets at heightFraction = 1f. Passed
// in (rather than a fixed constant) so it can reach nearly the full screen
// height when the caller wants "reveal everything, even if it covers the
// avatar" - the drawer itself doesn't know or care what's behind it.
@Composable
fun ChatLogDrawer(
    messages: List<ChatMessage>,
    state: ChatLogDrawerState,
    maxExpandedHeight: androidx.compose.ui.unit.Dp,
    modifier: Modifier = Modifier
) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val expandableRangePx = with(density) { (maxExpandedHeight - HANDLE_HEIGHT).toPx() }
    val currentHeight = HANDLE_HEIGHT + with(density) { (expandableRangePx * state.heightFraction.value).toDp() }

    // LaunchedEffect(listState) below only launches ONCE (listState is a
    // stable object that never changes for this composable's lifetime), so
    // its coroutine body runs exactly once too - a plain `messages` closure
    // capture there would freeze at whatever value existed at that single
    // launch (confirmed for real: it froze at the startup-empty list, before
    // the history poll had loaded anything, so every later scroll attempt
    // from inside that effect saw messagesEmpty=true forever even once
    // real messages existed). rememberUpdatedState keeps this read live
    // across recompositions no matter how long the surrounding effect itself
    // has been running.
    val currentMessages by rememberUpdatedState(messages)

    // scrollToItem(lastIndex) alone only pins that item's TOP to the
    // viewport's top - if the newest message is taller than the remaining
    // space (e.g. the keyboard just ate most of the drawer's height), its
    // own tail still gets clipped off the bottom. scrollOffset = Int.MAX_VALUE
    // is the standard one-call trick to reach the true end of a LazyColumn's
    // content without reverseLayout - the implementation clamps the
    // oversized request down to the real max scroll position internally, in
    // the SAME call, so there's no gap between two separate calls for a
    // resize to land in and leave the second one acting on stale layout info
    // (confirmed for real: a two-step scrollToItem-then-scrollBy version
    // kept under-scrolling specifically right as the keyboard's resize
    // landed, even when triggered off the LazyColumn's own real measured
    // viewport size).
    // Guarded on heightFraction too, not just messages.isEmpty() - while
    // collapsed (handle only), the LazyColumn's weight(1f) gets 0dp of
    // actual height, and a separate scrollBy call there was confirmed for
    // real to freeze the handle's own tap/drag entirely (see git history) -
    // there's nothing to scroll into view while collapsed anyway.
    suspend fun scrollToTrueBottom() {
        if (currentMessages.isEmpty() || state.heightFraction.value <= 0.5f) return
        listState.scrollToItem(currentMessages.size - 1, scrollOffset = Int.MAX_VALUE)
    }

    // Jump to the newest message whenever the list grows, or right as the
    // drawer opens - otherwise it started scrolled to the oldest message
    // (the top), the opposite of the desktop chat window's always-latest view.
    LaunchedEffect(messages.size) { scrollToTrueBottom() }
    LaunchedEffect(state.heightFraction.value > 0.5f) { scrollToTrueBottom() }
    // Re-pin to the bottom whenever the LazyColumn's own REAL measured
    // viewport actually changes size - e.g. the keyboard opening while the
    // chat log is showing shrinks it. Deliberately watches
    // listState.layoutInfo.viewportSize (a snapshot of the real post-layout
    // measurement) instead of the maxExpandedHeight Dp this composable
    // computes from bottomBarHeightPx - that computed value updates on
    // recomposition a frame before the LazyColumn's own layout pass actually
    // applies it, so scrolling off that Dp was racing the real resize.
    // Launches once (listState is stable) and keeps running for this
    // composable's whole lifetime - which is exactly why scrollToTrueBottom
    // must read messages through rememberUpdatedState rather than closing
    // over the parameter directly (see currentMessages above).
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.viewportSize }.collect {
            scrollToTrueBottom()
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .height(currentHeight)
            .background(MaterialTheme.colorScheme.background)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(HANDLE_HEIGHT)
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { scope.launch { state.toggle() } })
                }
                .pointerInput(Unit) {
                    detectVerticalDragGestures(
                        onDragEnd = {
                            scope.launch {
                                val target = if (state.heightFraction.value > 0.5f) 1f else 0f
                                state.heightFraction.animateTo(target, tween(220, easing = FastOutSlowInEasing))
                            }
                        }
                    ) { change, dragAmount ->
                        change.consume()
                        val deltaFraction = -dragAmount / expandableRangePx
                        scope.launch {
                            state.heightFraction.snapTo((state.heightFraction.value + deltaFraction).coerceIn(0f, 1f))
                        }
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Box(
                Modifier
                    .width(36.dp)
                    .height(4.dp)
                    .background(
                        MaterialTheme.colorScheme.onBackground.copy(alpha = 0.4f),
                        RoundedCornerShape(2.dp)
                    )
            )
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(messages) { message -> MessageBubble(message) }
        }
    }
}

@Composable
fun MessageBubble(message: ChatMessage) {
    val isUser = message.role == "user"
    val icon = if (message.source == "desktop") "💻" else "📱" // 💻 / 📱
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Surface(
            color = if (isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.secondaryContainer,
            contentColor = if (isUser) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSecondaryContainer,
            shape = MaterialTheme.shapes.medium
        ) {
            val photoSuffix = if (message.photoCount > 0) " 📷${message.photoCount}" else ""
            Text("$icon ${message.text}$photoSuffix", modifier = Modifier.padding(10.dp))
        }
    }
}
