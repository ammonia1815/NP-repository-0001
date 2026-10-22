package com.npcompanion.app

import android.opengl.GLES20
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import androidx.media3.effect.SingleFrameGlShaderProgram
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

// Keys out a known solid backdrop color at render time, after the video has
// already been decoded normally by the phone's hardware H.264 decoder - this
// exists because Android has no ready-to-use decoder for real alpha-channel
// video (VP9/AV1-with-alpha would need building libvpx/libaom from source
// with the NDK), so the mobile avatar clips can't carry real per-pixel alpha
// the way the desktop's WebP-frame renderer does. Instead, each clip is
// pre-composited onto one known flat color (see the python pipeline that
// generated idle_loop_bluekey.mp4), and this shader erases that exact color
// back out on the GPU every frame. threshold/softness are both in the same
// 0..1 normalized RGB distance space GLSL's distance() uses (not 0..255).
@UnstableApi
class ChromaKeyEffect(
    private val keyColorRgb: FloatArray,
    private val threshold: Float,
    private val softness: Float
) : GlEffect {
    override fun toGlShaderProgram(context: android.content.Context, useHdr: Boolean): GlShaderProgram {
        return ChromaKeyShaderProgram(useHdr, keyColorRgb, threshold, softness)
    }
}

@UnstableApi
private class ChromaKeyShaderProgram(
    useHdr: Boolean,
    private val keyColorRgb: FloatArray,
    private val threshold: Float,
    private val softness: Float
) : SingleFrameGlShaderProgram(useHdr) {

    private var program = 0
    private var positionHandle = 0
    private var texCoordHandle = 0
    private var texSamplerHandle = 0
    private var keyColorHandle = 0
    private var thresholdHandle = 0
    private var softnessHandle = 0

    private val vertexBuffer: FloatBuffer = makeFloatBuffer(
        floatArrayOf(
            -1f, -1f,
            1f, -1f,
            -1f, 1f,
            1f, 1f
        )
    )
    // Flipped vertically relative to a naive (0,0)-top-left mapping - Media3
    // hands this shader program frames using the same bottom-left-origin
    // texture convention regular desktop/mobile GL content already assumes,
    // consistent with the un-rotated video looking correct in AvatarView.
    private val texCoordBuffer: FloatBuffer = makeFloatBuffer(
        floatArrayOf(
            0f, 0f,
            1f, 0f,
            0f, 1f,
            1f, 1f
        )
    )

    override fun configure(inputWidth: Int, inputHeight: Int): Size = Size(inputWidth, inputHeight)

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
        if (program == 0) initProgram()

        GLES20.glUseProgram(program)

        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, inputTexId)
        GLES20.glUniform1i(texSamplerHandle, 0)

        GLES20.glUniform3f(keyColorHandle, keyColorRgb[0], keyColorRgb[1], keyColorRgb[2])
        GLES20.glUniform1f(thresholdHandle, threshold)
        GLES20.glUniform1f(softnessHandle, softness)

        vertexBuffer.position(0)
        GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, vertexBuffer)
        GLES20.glEnableVertexAttribArray(positionHandle)

        texCoordBuffer.position(0)
        GLES20.glVertexAttribPointer(texCoordHandle, 2, GLES20.GL_FLOAT, false, 0, texCoordBuffer)
        GLES20.glEnableVertexAttribArray(texCoordHandle)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

        GLES20.glDisableVertexAttribArray(positionHandle)
        GLES20.glDisableVertexAttribArray(texCoordHandle)
    }

    override fun release() {
        super.release()
        if (program != 0) {
            GLES20.glDeleteProgram(program)
            program = 0
        }
    }

    private fun initProgram() {
        val vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER_SRC)
        val fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)
        program = GLES20.glCreateProgram().also {
            GLES20.glAttachShader(it, vertexShader)
            GLES20.glAttachShader(it, fragmentShader)
            GLES20.glLinkProgram(it)
            val linked = IntArray(1)
            GLES20.glGetProgramiv(it, GLES20.GL_LINK_STATUS, linked, 0)
            if (linked[0] == 0) {
                val log = GLES20.glGetProgramInfoLog(it)
                GLES20.glDeleteProgram(it)
                throw VideoFrameProcessingException("ChromaKeyEffect program link failed: $log")
            }
        }
        positionHandle = GLES20.glGetAttribLocation(program, "aPosition")
        texCoordHandle = GLES20.glGetAttribLocation(program, "aTexCoord")
        texSamplerHandle = GLES20.glGetUniformLocation(program, "uTexSampler")
        keyColorHandle = GLES20.glGetUniformLocation(program, "uKeyColor")
        thresholdHandle = GLES20.glGetUniformLocation(program, "uThreshold")
        softnessHandle = GLES20.glGetUniformLocation(program, "uSoftness")
    }

    private fun compileShader(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        val compiled = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
        if (compiled[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(shader)
            GLES20.glDeleteShader(shader)
            throw VideoFrameProcessingException("ChromaKeyEffect shader compile failed: $log")
        }
        return shader
    }

    companion object {
        private const val VERTEX_SHADER_SRC = """
            attribute vec2 aPosition;
            attribute vec2 aTexCoord;
            varying vec2 vTexCoord;
            void main() {
                gl_Position = vec4(aPosition, 0.0, 1.0);
                vTexCoord = aTexCoord;
            }
        """

        // distance()/smoothstep() operate in GL's normalized 0..1 color
        // space, not 0..255 - the key color and threshold/softness passed in
        // from Kotlin must already be normalized to match.
        private const val FRAGMENT_SHADER_SRC = """
            precision mediump float;
            varying vec2 vTexCoord;
            uniform sampler2D uTexSampler;
            uniform vec3 uKeyColor;
            uniform float uThreshold;
            uniform float uSoftness;
            void main() {
                vec4 color = texture2D(uTexSampler, vTexCoord);
                float dist = distance(color.rgb, uKeyColor);
                float alpha = smoothstep(uThreshold, uThreshold + uSoftness, dist);
                gl_FragColor = vec4(color.rgb * alpha, alpha);
            }
        """

        private fun makeFloatBuffer(values: FloatArray): FloatBuffer {
            return ByteBuffer.allocateDirect(values.size * 4)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
                .apply {
                    put(values)
                    position(0)
                }
        }
    }
}
