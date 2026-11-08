package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.crypto.JcaDeviceKey
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** Chiavi software P-256 per i test (sul telefono la chiave sta nell'Android Keystore). */
object TestKeys {
    /**
     * Chiave di prova fissa, generata con .NET insieme ai vettori di [Vectors]. Solo per i test:
     * non è usata da nessuna parte.
     */
    const val PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJ7cp8Ja6Ai2rq3Kym0MdTruWBkzACIDp2lZ1MVkifTqhRANCAASxjUwpldukMM3EFGOqEB6hoBvuz14rzconceYIcMpZHrvbe2TYL7uFbztvGs6JkToDe4Sq+0FFDxtijIVsxYH/"
    const val SPKI = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsY1MKZXbpDDNxBRjqhAeoaAb7s9eK83KJ3HmCHDKWR6723tk2C+7hW87bxrOiZE6A3uEqvtBRQ8bYoyFbMWB/w=="

    fun fixed(): JcaDeviceKey {
        val kf = KeyFactory.getInstance("EC")
        val priv = kf.generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(PKCS8)))
        val pub = kf.generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(SPKI)))
        return JcaDeviceKey(priv, pub)
    }

    fun random(): JcaDeviceKey {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        return JcaDeviceKey(kp.private, kp.public)
    }
}

/**
 * Prodotti da `api/tools/sign-request` (stessa costruzione di `KeyFile.Token`) con la chiave
 * [TestKeys.PKCS8], `iat` = 1793430000, `jti` = "AAECAwQFBgcICQoLDA0ODw", `av` = 10300.
 */
object Vectors {
    const val DEVICE_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
    const val IAT = 1793430000L
    const val JTI = "AAECAwQFBgcICQoLDA0ODw"
    const val AV = 10300

    const val GET_PATH = "/api/app/lookup?ean=8012345678901"
    const val GET_TOKEN =
        "eyJhbGciOiJFUzI1NiIsInR5cCI6ImNtLXJlcVx1MDAyQmp3dCIsImtpZCI6IjAxOTlhMWIyLWMzZDQtN2U1Zi04YTliLTBjMWQyZTNmNGE1YiJ9." +
            "eyJpYXQiOjE3OTM0MzAwMDAsImV4cCI6MTc5MzQzMDA2MCwianRpIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyIsImh0bSI6IkdFVCIsImh0dSI6Ii9hcGkvYXBwL2xvb2t1cD9lYW49ODAxMjM0NTY3ODkwMSIsImF2IjoxMDMwMH0." +
            "foUKEmbwy8ED5uSRmAOvpJUuAU6PIYS9mZWWnv5CDT5dXz49DizB764GL06Frkk2n3WzoS1IBNRH4b9dfJ-5rA"

    const val POST_PATH = "/api/app/movies"
    const val POST_BODY = """{"movie":{"title":"Il padrino","year":1972}}"""
    const val POST_TOKEN =
        "eyJhbGciOiJFUzI1NiIsInR5cCI6ImNtLXJlcVx1MDAyQmp3dCIsImtpZCI6IjAxOTlhMWIyLWMzZDQtN2U1Zi04YTliLTBjMWQyZTNmNGE1YiJ9." +
            "eyJpYXQiOjE3OTM0MzAwMDAsImV4cCI6MTc5MzQzMDA2MCwianRpIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyIsImh0bSI6IlBPU1QiLCJodHUiOiIvYXBpL2FwcC9tb3ZpZXMiLCJhdiI6MTAzMDAsImJoIjoiWU1ibm94Rmppc3E5eEdYb1lUQ2I2SUVjaklIb2U5M2FPaHIyMHFXT25xQSJ9." +
            "ivHMvFoKW7FDhBJ_o6rPeaRU4v8Co4WQyiwd6LpUwiVMxh8ZM8NBbdk6pf0hw-PNCK8jgrJnFWeMkVokhhoqyw"

    const val PAIR_CODE = "jpg6Ja2nt9yODJ4ib-PhfA"
    const val PAIR_PROOF = "-krhVSteTB77lvw2IY74-ZEma8kVLJBtnnDk-B3ESmwpCC4qPtlRjERrlVT4Y4DLzm6-KPoh8ojvNi1kDFcxpA"
}
