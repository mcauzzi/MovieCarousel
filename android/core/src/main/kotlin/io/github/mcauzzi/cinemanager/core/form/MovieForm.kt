package io.github.mcauzzi.cinemanager.core.form

import io.github.mcauzzi.cinemanager.core.api.Field
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/** Tipi dei campi della collezione (docs/api.md, `GET /api/collection`). */
enum class FieldType {
    LINE, PARA, NUMBER, BOOL, DATE, CHOICE, URL, RATING, TABLE, OTHER;

    companion object {
        fun of(type: String): FieldType = when (type) {
            "line" -> LINE
            "para" -> PARA
            "number" -> NUMBER
            "bool" -> BOOL
            "date" -> DATE
            "choice" -> CHOICE
            "url" -> URL
            "rating" -> RATING
            "table" -> TABLE
            else -> OTHER
        }
    }
}

/** Valore modificabile di un campo nel modulo. */
sealed interface FieldValue {
    /** Campi a valore singolo (testo, numero, data, URL, scelta, voto) come testo. */
    data class Text(val value: String) : FieldValue

    /** Campi multipli, come chip. */
    data class Multi(val values: List<String>) : FieldValue

    /** Interruttore (`bool`). */
    data class Flag(val checked: Boolean) : FieldValue

    /** Tabelle: righe di celle (`cast`: attore, ruolo). */
    data class Rows(val rows: List<List<String>>) : FieldValue
}

/** Campo del modulo: definizione + controllo da usare. */
data class FormField(val def: Field) {
    val type: FieldType = FieldType.of(def.type)
    val isCast: Boolean get() = def.name == MovieForm.CAST

    /**
     * Valori proposti: gli `allowed` del campo; per il supporto (`medium`) senza `allowed`
     * i default DVD / Blu-ray / 4K (§11).
     */
    val options: List<String>
        get() = def.allowed?.takeIf { it.isNotEmpty() }
            ?: if (def.name == MovieForm.MEDIUM) MovieForm.DEFAULT_MEDIA else emptyList()

    /** Valori ammessi in modo vincolante (scelta da lista). */
    val restricted: Boolean get() = type == FieldType.CHOICE && !def.allowed.isNullOrEmpty()

    fun empty(): FieldValue = when {
        type == FieldType.BOOL -> FieldValue.Flag(false)
        type == FieldType.TABLE -> FieldValue.Rows(emptyList())
        def.multiple -> FieldValue.Multi(emptyList())
        else -> FieldValue.Text("")
    }
}

/**
 * Modulo del film costruito da `GET /api/app/fields` e precompilato con la bozza di `lookup`
 * (stessa forma dei film del parser). [toMovieJson] produce il `movie` di `POST /api/app/movies`.
 */
object MovieForm {
    const val TITLE = "title"
    const val CAST = "cast"
    const val MEDIUM = "medium"
    val DEFAULT_MEDIA = listOf("DVD", "Blu-ray", "4K")

    /** Impostati dal server o non scrivibili dall'app (docs/api.md, `POST /api/app/movies`). */
    private val SERVER_FIELDS = setOf("id", "cdate", "mdate", "cover")

    /** Campi mostrati, nell'ordine della collezione (`ordinal`, poi nome). */
    fun formFields(fields: List<Field>): List<FormField> = fields
        .filter { it.inForm && it.name !in SERVER_FIELDS && it.type != "image" && it.type != "dependent" }
        .sortedWith(compareBy<Field> { it.ordinal }.thenBy { it.name })
        .map(::FormField)

    /** Valori iniziali dalla bozza; i campi assenti partono vuoti. */
    fun initialValues(fields: List<FormField>, draft: JsonObject): Map<String, FieldValue> =
        fields.associate { f -> f.def.name to (draft[f.def.name]?.let { fromJson(f, it) } ?: f.empty()) }

    /** Campi della bozza che il modulo non mostra: vengono reinviati così come sono. */
    fun passthrough(fields: List<FormField>, draft: JsonObject): JsonObject {
        val shown = fields.mapTo(HashSet()) { it.def.name }
        return JsonObject(draft.filterKeys { it !in shown && it !in SERVER_FIELDS })
    }

    fun fromJson(field: FormField, value: JsonElement): FieldValue = when (field.type) {
        FieldType.BOOL -> FieldValue.Flag(
            (value as? JsonPrimitive)?.let { it.contentOrNull == "true" || it.content == "1" } ?: false,
        )
        FieldType.TABLE -> FieldValue.Rows(
            (value as? JsonArray).orEmpty().mapNotNull { row ->
                when (row) {
                    is JsonObject -> if (field.isCast) listOf(row.cell("actor"), row.cell("role")) else row.values.map(::text)
                    is JsonArray -> row.map(::text)
                    is JsonPrimitive -> listOf(text(row))
                }
            },
        )
        else -> if (field.def.multiple) {
            FieldValue.Multi(
                when (value) {
                    is JsonArray -> value.map(::text).filter { it.isNotBlank() }
                    is JsonPrimitive -> listOfNotNull(text(value).takeIf { it.isNotBlank() })
                    else -> emptyList()
                },
            )
        } else {
            FieldValue.Text(
                when (value) {
                    is JsonArray -> value.firstOrNull()?.let(::text).orEmpty()
                    else -> text(value)
                },
            )
        }
    }

    /**
     * Il `movie` da inviare: valori vuoti omessi (il server li ignorerebbe), numeri come interi
     * quando validi (altrimenti il testo, e l'errore arriva dal server), `bool` vero → `"true"`.
     */
    fun toMovieJson(fields: List<FormField>, values: Map<String, FieldValue>, passthrough: JsonObject = JsonObject(emptyMap())): JsonObject =
        buildJsonObject {
            passthrough.forEach { (k, v) -> put(k, v) }
            for (f in fields) {
                val json = values[f.def.name]?.let { toJson(f, it) } ?: continue
                put(f.def.name, json)
            }
        }

    fun toJson(field: FormField, value: FieldValue): JsonElement? = when (value) {
        is FieldValue.Flag -> if (value.checked) JsonPrimitive("true") else null
        is FieldValue.Text -> value.value.trim().takeIf { it.isNotEmpty() }?.let { scalar(field, it) }
        is FieldValue.Multi -> value.values.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
            .takeIf { it.isNotEmpty() }
            ?.let { list -> buildJsonArray { list.forEach { add(scalar(field, it)) } } }
        is FieldValue.Rows -> value.rows.map { r -> r.map { it.trim() } }.filter { r -> r.any { it.isNotEmpty() } }
            .takeIf { it.isNotEmpty() }
            ?.let { rows ->
                buildJsonArray {
                    rows.forEach { r ->
                        if (field.isCast) {
                            add(buildJsonObject { put("actor", JsonPrimitive(r.getOrElse(0) { "" })); put("role", JsonPrimitive(r.getOrElse(1) { "" })) })
                        } else {
                            add(buildJsonArray { r.forEach { add(JsonPrimitive(it)) } })
                        }
                    }
                }
            }
    }

    /** Errori bloccanti lato app (gli altri li segnala il server, campo per campo). */
    fun validate(fields: List<FormField>, values: Map<String, FieldValue>): Map<String, String> {
        val errors = mutableMapOf<String, String>()
        val title = (values[TITLE] as? FieldValue.Text)?.value?.trim().orEmpty()
        if (fields.any { it.def.name == TITLE } && title.isEmpty()) errors[TITLE] = "Il titolo è obbligatorio."
        for (f in fields) {
            val v = values[f.def.name] as? FieldValue.Text ?: continue
            val s = v.value.trim()
            if (s.isEmpty()) continue
            when (f.type) {
                FieldType.NUMBER, FieldType.RATING ->
                    if (s.toLongOrNull() == null) errors[f.def.name] = "Serve un numero intero."
                    else if (f.type == FieldType.RATING && s.toLong() !in 1..10) errors[f.def.name] = "Da 1 a 10."
                FieldType.DATE -> if (!DATE.matches(s)) errors[f.def.name] = "Formato AAAA-MM-GG."
                FieldType.URL -> if (!s.startsWith("http://") && !s.startsWith("https://")) errors[f.def.name] = "Serve un indirizzo http(s)."
                FieldType.CHOICE -> if (f.restricted && f.options.none { it.equals(s, ignoreCase = true) })
                    errors[f.def.name] = "Scegli un valore dall'elenco."
                else -> Unit
            }
        }
        return errors
    }

    private val DATE = Regex("""\d{4}-\d{2}-\d{2}""")

    private fun scalar(field: FormField, s: String): JsonPrimitive = when (field.type) {
        FieldType.NUMBER, FieldType.RATING -> s.toLongOrNull()?.let(::JsonPrimitive) ?: JsonPrimitive(s)
        else -> JsonPrimitive(s)
    }

    private fun JsonObject.cell(name: String) = this[name]?.let(::text).orEmpty()

    private fun text(e: JsonElement): String = when (e) {
        is JsonNull -> ""
        is JsonPrimitive -> e.longOrNull?.toString() ?: e.content
        else -> e.toString()
    }
}

/** Codici a barre accettati: EAN-8, UPC-A, EAN-13 (e fino a 14 cifre, come l'API). */
object Ean {
    /** Solo cifre, 8–14; null se non valido. Lo zero davanti agli UPC-A lo aggiunge il server. */
    fun normalize(input: String): String? {
        val digits = input.filter { !it.isWhitespace() && it != '-' }
        if (digits.length !in 8..14 || digits.any { it !in '0'..'9' }) return null
        return digits
    }

    /** Cifra di controllo GS1 (EAN-8/12/13/14). */
    fun hasValidCheckDigit(code: String): Boolean {
        if (code.length !in setOf(8, 12, 13, 14) || code.any { it !in '0'..'9' }) return false
        val digits = code.map { it - '0' }
        val body = digits.dropLast(1).reversed()
        val sum = body.withIndex().sumOf { (i, d) -> if (i % 2 == 0) d * 3 else d }
        return (10 - sum % 10) % 10 == digits.last()
    }
}
