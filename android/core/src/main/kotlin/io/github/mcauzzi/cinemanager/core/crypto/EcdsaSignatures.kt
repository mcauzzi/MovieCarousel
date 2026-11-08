package io.github.mcauzzi.cinemanager.core.crypto

/**
 * Conversione delle firme ECDSA P-256 tra il formato DER di JCA (`SHA256withECDSA`, anche
 * nell'Android Keystore) e il formato JOSE `R||S` a 64 byte richiesto da ES256 (RFC 7518 §3.4).
 */
object EcdsaSignatures {
    /** Lunghezza in byte di R e di S per P-256. */
    const val P256_COMPONENT = 32

    /** DER `SEQUENCE { INTEGER r, INTEGER s }` → `R||S` (64 byte). */
    fun derToJose(der: ByteArray, componentLength: Int = P256_COMPONENT): ByteArray {
        var i = 0
        fun next(): Int {
            require(i < der.size) { "Firma DER troncata" }
            return der[i++].toInt() and 0xFF
        }
        fun length(): Int {
            val first = next()
            if (first < 0x80) return first
            val count = first and 0x7F
            require(count in 1..2) { "Lunghezza DER non valida" }
            var len = 0
            repeat(count) { len = (len shl 8) or next() }
            require(len >= 0x80) { "Lunghezza DER non minima" }
            return len
        }
        fun integer(): ByteArray {
            require(next() == 0x02) { "Atteso INTEGER" }
            val len = length()
            require(len in 1..(componentLength + 1) && i + len <= der.size) { "INTEGER DER non valido" }
            val value = der.copyOfRange(i, i + len)
            i += len
            require(value[0].toInt() and 0x80 == 0) { "INTEGER DER negativo" }
            // Zero iniziale ammesso solo se serve a tenere positivo il numero.
            require(!(value.size > 1 && value[0].toInt() == 0 && value[1].toInt() and 0x80 == 0)) { "INTEGER DER non minimo" }
            val trimmed = if (value.size > 1 && value[0].toInt() == 0) value.copyOfRange(1, value.size) else value
            require(trimmed.size <= componentLength) { "Componente troppo lunga" }
            return ByteArray(componentLength - trimmed.size) + trimmed
        }

        require(next() == 0x30) { "Attesa SEQUENCE" }
        val seqLen = length()
        require(i + seqLen == der.size) { "Lunghezza della SEQUENCE incoerente" }
        val r = integer()
        val s = integer()
        require(i == der.size) { "Byte in eccesso nella firma DER" }
        return r + s
    }
}
