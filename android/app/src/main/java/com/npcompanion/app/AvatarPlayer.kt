package com.npcompanion.app

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer

// Direct port of src/renderer/avatar/avatar.ts's state machine, with the
// WebP frame-sequence player replaced by video playback (see the plan doc
// for why: preloading all 1108 source frames as bitmaps would need several
// GB of RAM, an instant OOM on a phone). The three "resting" loops sit in a
// fixed linear chain - idle <-> thinking <-> search - and every externally
// requested state just walks one link at a time toward the target,
// finishing whatever one-shot transition is already in flight first.
//
// All seven clips are now re-composited onto the known solid blue (see
// ChromaKeyEffect.kt) instead of the navy they used to be baked onto, so the
// chroma-key shader can erase that backdrop back out at render time on every
// state, not just idle.
enum class LoopState(val asset: String) {
    Idle("asset:///avatar/idle_loop_bluekey.mp4"),
    Thinking("asset:///avatar/thinking_loop_bluekey.mp4"),
    Search("asset:///avatar/search_loop_bluekey.mp4"),
}

enum class TransitionState(val asset: String, val landsOn: LoopState) {
    // exit_thinking is a pre-baked reverse of enter_thinking (see the plan
    // doc's ffmpeg step) - Android video players don't reliably support
    // backward playback, so the reverse was rendered once at build time
    // instead. Played forward, it reproduces the same visual as the
    // desktop's "play enter_thinking backward".
    EnterThinking("asset:///avatar/enter_thinking_bluekey.mp4", LoopState.Thinking),
    ExitThinking("asset:///avatar/exit_thinking_bluekey.mp4", LoopState.Idle),
    EnterSearch("asset:///avatar/enter_search_bluekey.mp4", LoopState.Search),
    // exit_search is a genuinely distinct clip, not a reverse of enter_search.
    ExitSearch("asset:///avatar/exit_search_bluekey.mp4", LoopState.Thinking),
}

private val CHAIN_ORDER = listOf(LoopState.Idle, LoopState.Thinking, LoopState.Search)

// The specific navy this whole pipeline used to bake in (#111E20) is being
// phased out clip by clip in favor of this more chroma-key-friendly blue,
// chosen and pixel-distance-checked against the character's actual palette
// (see the analysis that produced 크로마키_영향범위_확인용.png) precisely
// because it's far enough from her skin/hair/clothing tones that a
// reasonably tight threshold can erase it without eating into her.
private val CHROMA_KEY_COLOR = floatArrayOf(1f / 255f, 97f / 255f, 220f / 255f)
private const val CHROMA_KEY_THRESHOLD = 0.15f
private const val CHROMA_KEY_SOFTNESS = 0.08f

@OptIn(UnstableApi::class)
class AvatarPlayer(context: Context) {
    val exoPlayer: ExoPlayer = ExoPlayer.Builder(context).build()

    private var currentLoop: LoopState = LoopState.Idle
    private var currentTransition: TransitionState? = null
    private var pendingExternal: String? = null

    init {
        exoPlayer.repeatMode = Player.REPEAT_MODE_ONE
        exoPlayer.setMediaItem(MediaItem.fromUri(currentLoop.asset))
        exoPlayer.setVideoEffects(
            listOf(ChromaKeyEffect(CHROMA_KEY_COLOR, CHROMA_KEY_THRESHOLD, CHROMA_KEY_SOFTNESS))
        )
        exoPlayer.prepare()
        exoPlayer.play()

        exoPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    val finished = currentTransition ?: return
                    currentTransition = null
                    landInLoop(finished.landsOn)
                }
            }
        })
    }

    // state: "idle" | "thinking" | "searching" - matches the exact wire
    // values the server sends (see AvatarState in chat-service.ts). Any
    // other value (e.g. "screen", which has no dedicated clip yet) collapses
    // to "thinking", mirroring the desktop's onStateChange handler.
    fun requestState(state: String) {
        val normalized = when (state) {
            "idle" -> "idle"
            "searching" -> "searching"
            else -> "thinking"
        }
        pendingExternal = normalized
        // If already sitting still in a loop, act immediately - a transition
        // already in flight will pick this up itself once it lands.
        if (currentTransition == null) {
            maybeAdvanceTowardPending(currentLoop)
        }
    }

    private fun targetLoopFor(external: String): LoopState = when (external) {
        "idle" -> LoopState.Idle
        "searching" -> LoopState.Search
        else -> LoopState.Thinking
    }

    private fun maybeAdvanceTowardPending(loop: LoopState) {
        val external = pendingExternal ?: return
        val targetLoop = targetLoopFor(external)
        val curIdx = CHAIN_ORDER.indexOf(loop)
        val targetIdx = CHAIN_ORDER.indexOf(targetLoop)

        if (curIdx == targetIdx) {
            pendingExternal = null
            return
        }

        val next = when {
            curIdx == 0 && targetIdx > 0 -> TransitionState.EnterThinking
            curIdx == 1 && targetIdx == 0 -> TransitionState.ExitThinking
            curIdx == 1 && targetIdx == 2 -> TransitionState.EnterSearch
            curIdx == 2 && targetIdx <= 1 -> TransitionState.ExitSearch
            else -> null
        } ?: return

        playTransition(next)
    }

    private fun playTransition(transition: TransitionState) {
        currentTransition = transition
        exoPlayer.repeatMode = Player.REPEAT_MODE_OFF
        exoPlayer.setMediaItem(MediaItem.fromUri(transition.asset))
        exoPlayer.prepare()
        exoPlayer.play()
    }

    private fun landInLoop(loop: LoopState) {
        currentLoop = loop
        exoPlayer.repeatMode = Player.REPEAT_MODE_ONE
        exoPlayer.setMediaItem(MediaItem.fromUri(loop.asset))
        exoPlayer.prepare()
        exoPlayer.play()
        maybeAdvanceTowardPending(loop)
    }

    fun release() {
        exoPlayer.release()
    }
}
