package io.github.mcauzzi.cinemanager.core.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Forme JSON di docs/api.md (camelCase). Le proprietà sconosciute vengono ignorate.

@Serializable
data class PairRequest(val code: String, val deviceName: String, val publicKey: String, val proof: String)

@Serializable
data class UserRef(val name: String = "")

@Serializable
data class PairResponse(val deviceId: String, val user: UserRef = UserRef())

@Serializable
data class AppMe(val deviceId: String, val deviceName: String = "", val user: UserRef = UserRef())

/** Definizione di un campo della collezione (`GET /api/app/fields`). */
@Serializable
data class Field(
    val name: String,
    val title: String = name,
    val type: String = "line",
    val multiple: Boolean = false,
    val allowed: List<String>? = null,
    val inForm: Boolean = true,
    val ordinal: Int = 0,
)

@Serializable
data class Candidate(
    val tmdbId: Int,
    val title: String,
    val originalTitle: String? = null,
    val year: Int? = null,
    val posterPath: String? = null,
    val posterUrl: String? = null,
)

@Serializable
data class DuplicateRef(val id: Long, val title: String? = null, val year: Int? = null)

@Serializable
data class LookupResponse(
    val ean: String,
    val productName: String? = null,
    val tmdbId: Int? = null,
    val posterPath: String? = null,
    val posterUrl: String? = null,
    val draft: JsonObject = JsonObject(emptyMap()),
    val candidates: List<Candidate> = emptyList(),
    val possibleDuplicates: List<DuplicateRef> = emptyList(),
    val tmdbAvailable: Boolean = true,
)

@Serializable
data class SearchResponse(val candidates: List<Candidate> = emptyList())

@Serializable
data class TmdbDraftResponse(
    val tmdbId: Int,
    val posterPath: String? = null,
    val posterUrl: String? = null,
    val draft: JsonObject = JsonObject(emptyMap()),
    val possibleDuplicates: List<DuplicateRef> = emptyList(),
)

/** Corpo di `POST /api/app/movies`; i null non vengono inviati. */
@Serializable
data class NewMovieRequest(
    val ean: String? = null,
    val tmdbId: Int? = null,
    val posterPath: String? = null,
    val movie: JsonObject,
    val confirmDuplicate: Boolean = false,
)

sealed interface CreateMovieResult {
    data class Created(val id: Long) : CreateMovieResult

    /** 409 `ean`: l'EAN è già nella collezione. */
    data class EanExists(val existingId: Long?, val title: String?) : CreateMovieResult

    /** 409 `possible_duplicate`: serve reinviare con `confirmDuplicate`. */
    data class PossibleDuplicate(val candidates: List<DuplicateRef>) : CreateMovieResult
}

/** `version.json` (§11.1), servito anche come `GET /api/app/version`. */
@Serializable
data class AppVersionInfo(
    val version: String,
    val versionCode: Int,
    val minSupportedCode: Int = 0,
    val sha256: String? = null,
    val commit: String? = null,
)

/** Esito del confronto tra la versione dell'app e `version.json`. */
enum class UpdateState { UP_TO_DATE, UPDATE_AVAILABLE, UPDATE_REQUIRED }

fun AppVersionInfo.stateFor(appVersionCode: Int): UpdateState = when {
    appVersionCode < minSupportedCode -> UpdateState.UPDATE_REQUIRED
    appVersionCode < versionCode -> UpdateState.UPDATE_AVAILABLE
    else -> UpdateState.UP_TO_DATE
}
