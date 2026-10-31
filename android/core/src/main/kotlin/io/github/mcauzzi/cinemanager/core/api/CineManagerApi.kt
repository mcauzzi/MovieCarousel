package io.github.mcauzzi.cinemanager.core.api

import io.github.mcauzzi.cinemanager.core.crypto.DeviceKey
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException
import io.github.mcauzzi.cinemanager.core.crypto.PairingProof
import io.github.mcauzzi.cinemanager.core.crypto.RequestTokenFactory
import io.github.mcauzzi.cinemanager.core.pairing.ServerUrls
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Dispositivo abbinato: id restituito da `pair` + chiave che firma le richieste. */
class DeviceCredentials(val deviceId: String, val key: DeviceKey)

/**
 * Client dell'API dell'app (docs/api.md). Le chiamate sotto `/api/app/` sono firmate con
 * [credentials]; `pair` e `version` no. Errori HTTP → [ApiException]; problemi della chiave →
 * [KeyUnavailableException]; rete → [ApiException.Network].
 */
class CineManagerApi(
    val server: ServerUrls,
    baseClient: OkHttpClient,
    private val credentials: DeviceCredentials?,
    private val appVersionCode: Int,
    tokens: RequestTokenFactory? = credentials?.let { RequestTokenFactory(it.key) },
) {
    private val plain: OkHttpClient = baseClient.newBuilder()
        .followRedirects(false) // un redirect porterebbe fuori dall'API (e, firmato, non varrebbe comunque)
        .followSslRedirects(false)
        .build()

    private val signed: OkHttpClient? = credentials?.let { c ->
        plain.newBuilder()
            .addNetworkInterceptor(SigningInterceptor(c.deviceId, tokens!!, appVersionCode))
            .build()
    }

    private val api: HttpUrl = server.apiBase.toHttpUrl()

    // ------------------------------------------------------------------ non firmate

    /** `GET /api/app/version`; null se il file manca (build senza APK) o non è valido. */
    suspend fun appVersion(): AppVersionInfo? {
        val req = Request.Builder().url(server.versionUrl).header("Accept", "application/json").get().build()
        return try {
            plain.newCall(req).await().use { res ->
                if (!res.isSuccessful) return null
                val text = withContext(Dispatchers.IO) { res.body?.string() }.orEmpty()
                JSON.decodeFromString(AppVersionInfo.serializer(), text)
            }
        } catch (_: IllegalArgumentException) {
            null // JSON non valido (es. pagina HTML al posto del file)
        } catch (e: IOException) {
            throw ApiException.Network(e)
        }
    }

    /**
     * `POST /api/app/pair` con la prova di possesso di [key] (§4.2). Non richiede [credentials]:
     * la chiave è quella appena generata.
     */
    suspend fun pair(code: String, deviceName: String, key: DeviceKey): PairResponse {
        val body = PairRequest(
            code = code,
            deviceName = deviceName,
            publicKey = Base64.getEncoder().encodeToString(key.publicKeySpki),
            proof = PairingProof.create(key, code),
        )
        val req = Request.Builder().url(url("app/pair"))
            .post(JSON.encodeToString(PairRequest.serializer(), body).toRequestBody(JSON_TYPE))
            .build()
        return execute(plain, req, PairResponse.serializer(), pairing = true)
    }

    // ------------------------------------------------------------------ firmate

    suspend fun me(): AppMe = execute(signed(), get("app/me"), AppMe.serializer())

    /** "Scollega": il dispositivo si revoca da solo. */
    suspend fun unpair() {
        executeRaw(signed(), Request.Builder().url(url("app/me")).delete().build()) { }
    }

    suspend fun fields(): List<Field> = execute(signed(), get("app/fields"), ListSerializer(Field.serializer()))

    suspend fun lookup(ean: String): LookupResponse =
        execute(signed(), get(url("app/lookup").newBuilder().addQueryParameter("ean", ean).build()), LookupResponse.serializer())

    suspend fun search(query: String, year: Int?): List<Candidate> {
        val u = url("app/search").newBuilder().addQueryParameter("q", query)
            .apply { if (year != null) addQueryParameter("year", year.toString()) }.build()
        return execute(signed(), get(u), SearchResponse.serializer(), tmdb = true).candidates
    }

    suspend fun tmdb(tmdbId: Int): TmdbDraftResponse =
        execute(signed(), get(url("app/tmdb/$tmdbId")), TmdbDraftResponse.serializer(), tmdb = true)

    /** `POST /api/app/movies`: 201 → [CreateMovieResult.Created]; i due 409 → esiti, non eccezioni. */
    suspend fun createMovie(request: NewMovieRequest): CreateMovieResult {
        val req = Request.Builder().url(url("app/movies"))
            .post(JSON.encodeToString(NewMovieRequest.serializer(), request).toRequestBody(JSON_TYPE))
            .build()
        return executeRaw(signed(), req, accept409 = true) { (status, text) ->
            val obj = runCatching { JSON.parseToJsonElement(text) as? JsonObject }.getOrNull()
            fun str(n: String) = (obj?.get(n) as? JsonPrimitive)?.contentOrNull
            if (status == 409) {
                when (str("reason")) {
                    "ean" -> CreateMovieResult.EanExists((obj?.get("existingId") as? JsonPrimitive)?.longOrNull, str("title"))
                    "possible_duplicate" -> CreateMovieResult.PossibleDuplicate(
                        obj?.get("candidates")?.let {
                            JSON.decodeFromJsonElement(ListSerializer(DuplicateRef.serializer()), it)
                        }.orEmpty(),
                    )
                    else -> throw ApiException.Server(409, str("detail") ?: str("title"))
                }
            } else {
                val id = (obj?.get("id") as? JsonPrimitive)?.longOrNull ?: throw ApiException.Server(status, "Risposta senza id")
                CreateMovieResult.Created(id)
            }
        }
    }

    // ------------------------------------------------------------------ infrastruttura

    private fun url(path: String): HttpUrl = api.newBuilder().addPathSegments(path).build()

    private fun get(path: String) = get(url(path))

    private fun get(u: HttpUrl) = Request.Builder().url(u).header("Accept", "application/json").get().build()

    private fun signed(): OkHttpClient =
        signed ?: throw KeyUnavailableException(KeyUnavailableException.Kind.MISSING)

    private suspend fun <T> execute(
        client: OkHttpClient,
        req: Request,
        serializer: KSerializer<T>,
        pairing: Boolean = false,
        tmdb: Boolean = false,
    ): T = executeRaw(client, req, pairing = pairing, tmdb = tmdb) { (status, text) ->
        try {
            JSON.decodeFromString(serializer, text)
        } catch (e: IllegalArgumentException) {
            throw ApiException.Server(status, "Risposta non valida: ${e.message}")
        }
    }

    private suspend fun <T> executeRaw(
        client: OkHttpClient,
        req: Request,
        pairing: Boolean = false,
        tmdb: Boolean = false,
        accept409: Boolean = false,
        onSuccess: (Pair<Int, String>) -> T,
    ): T {
        val (status, text, retryAfter) = try {
            client.newCall(req).await().use { res: Response ->
                Triple(res.code, withContext(Dispatchers.IO) { res.body?.string() }.orEmpty(), res.header("Retry-After"))
            }
        } catch (e: KeyUnavailableException) {
            throw e
        } catch (e: IOException) {
            throw ApiException.Network(e)
        }
        if (status in 200..299 || (accept409 && status == 409)) return onSuccess(status to text)
        throw ErrorMapper.map(status, text, retryAfter, pairing = pairing, tmdb = tmdb)
    }

    companion object {
        val JSON = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
            encodeDefaults = true
        }
        private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

        /** Client di base con timeout adatti a `lookup` (provider EAN + TMDb lato server). */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(40, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .build()
    }
}

/** [Call] come funzione sospesa, cancellabile. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, _, _ -> response.close() }
        }
    })
}
