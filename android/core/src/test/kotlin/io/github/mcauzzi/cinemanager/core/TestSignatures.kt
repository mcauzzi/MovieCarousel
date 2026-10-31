package io.github.mcauzzi.cinemanager.core

import java.io.ByteArrayOutputStream
import java.math.BigInteger

/** Conversioni che servono solo ai test (l'app firma soltanto: DER → JOSE sta in `EcdsaSignatures`). */
object TestSignatures {
    /** `R||S` → DER, per verificare con JCA una firma JOSE. */
    fun joseToDer(jose: ByteArray): ByteArray {
        require(jose.size % 2 == 0 && jose.isNotEmpty()) { "Firma JOSE non valida" }
        val half = jose.size / 2
        fun encInt(bytes: ByteArray): ByteArray = BigInteger(1, bytes).toByteArray() // con lo 0x00 se serve
        val r = encInt(jose.copyOfRange(0, half))
        val s = encInt(jose.copyOfRange(half, jose.size))
        val body = ByteArrayOutputStream().apply {
            write(0x02); writeLength(r.size); write(r)
            write(0x02); writeLength(s.size); write(s)
        }.toByteArray()
        return ByteArrayOutputStream().apply {
            write(0x30); writeLength(body.size); write(body)
        }.toByteArray()
    }

    private fun ByteArrayOutputStream.writeLength(len: Int) {
        if (len < 0x80) write(len) else { write(0x81); write(len) }
    }
}
