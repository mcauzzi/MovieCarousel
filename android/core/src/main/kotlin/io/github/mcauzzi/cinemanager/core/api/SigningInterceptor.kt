package io.github.mcauzzi.cinemanager.core.api

import io.github.mcauzzi.cinemanager.core.crypto.RequestTokenFactory
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Response
import okio.Buffer

/**
 * Firma ogni richiesta con un JWT nuovo (`Authorization: CM-Device <jwt>`).
 *
 * Va registrato come *network interceptor*: vede l'URL e il corpo esattamente come partono e,
 * se OkHttp ritenta la connessione, ogni tentativo riceve un `jti` nuovo (il server rifiuta i
 * `jti` già visti).
 */
class SigningInterceptor(
    private val deviceId: String,
    private val tokens: RequestTokenFactory,
    private val appVersionCode: Int,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val body = request.body?.let { b -> Buffer().also { b.writeTo(it) }.readByteArray() }
        val token = tokens.create(
            deviceId = deviceId,
            method = request.method,
            pathAndQuery = requestTarget(request.url),
            body = body,
            appVersionCode = appVersionCode,
        )
        return chain.proceed(
            request.newBuilder()
                .header("Authorization", RequestTokenFactory.AUTHORIZATION_PREFIX + token)
                .build(),
        )
    }

    companion object {
        /** Request-target come lo scrive OkHttp sulla connessione (`RequestLine.requestPath`). */
        fun requestTarget(url: HttpUrl): String {
            val path = url.encodedPath
            val query = url.encodedQuery
            return if (query != null) "$path?$query" else path
        }
    }
}
