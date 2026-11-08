package io.github.mcauzzi.cinemanager.core.crypto

import java.util.Base64

/** Base64url senza padding (RFC 7515 §2), come `Base64Url` dell'API. */
object Base64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    fun encode(data: ByteArray): String = encoder.encodeToString(data)

    /** Decodifica rigorosa: solo `A-Z a-z 0-9 - _`, niente padding; null altrimenti. */
    fun decode(s: String): ByteArray? {
        if (s.length % 4 == 1) return null
        if (s.any { !(it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_') }) return null
        return try {
            decoder.decode(s)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}
