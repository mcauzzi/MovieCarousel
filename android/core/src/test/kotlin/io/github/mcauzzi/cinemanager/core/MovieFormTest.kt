package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.api.Field
import io.github.mcauzzi.cinemanager.core.form.Ean
import io.github.mcauzzi.cinemanager.core.form.FieldValue
import io.github.mcauzzi.cinemanager.core.form.MovieForm
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MovieFormTest {
    private val fields = listOf(
        Field("title", "Titolo", "line", ordinal = 0),
        Field("year", "Anno", "number", ordinal = 1),
        Field("director", "Regista", "line", multiple = true, ordinal = 3),
        Field("genre", "Genere", "line", multiple = true, ordinal = 2),
        Field("cast", "Cast", "table", multiple = true, ordinal = 4),
        Field("medium", "Supporto", "choice", allowed = listOf("DVD", "Blu-ray"), ordinal = 5),
        Field("visto", "Visto", "bool", ordinal = 6),
        Field("cover", "Copertina", "image", ordinal = 7),
        Field("cdate", "Creato", "date", ordinal = 8),
        Field("note", "Note", "para", inForm = false, ordinal = 9),
        Field("tracce", "Tracce", "table", ordinal = 10),
    )

    private val draft = Json.parseToJsonElement(
        """{"title":"Il padrino","year":1972,"director":["Francis Ford Coppola"],"genre":["Drammatico","Crime"],
           "cast":[{"actor":"Marlon Brando","role":"Vito Corleone"}],"plot":"…","running-time":175}""",
    ) as JsonObject

    @Test
    fun `campi del modulo in ordine, senza quelli del server`() {
        val f = MovieForm.formFields(fields)
        assertEquals(listOf("title", "year", "genre", "director", "cast", "medium", "visto", "tracce"), f.map { it.def.name })
    }

    @Test
    fun `bozza precompilata e reinviata uguale`() {
        val f = MovieForm.formFields(fields)
        val values = MovieForm.initialValues(f, draft)
        assertEquals(FieldValue.Text("1972"), values["year"])
        assertEquals(FieldValue.Multi(listOf("Drammatico", "Crime")), values["genre"])
        assertEquals(FieldValue.Rows(listOf(listOf("Marlon Brando", "Vito Corleone"))), values["cast"])
        assertEquals(FieldValue.Flag(false), values["visto"])

        val pass = MovieForm.passthrough(f, draft)
        assertEquals(setOf("plot", "running-time"), pass.keys)
        val movie = MovieForm.toMovieJson(f, values, pass)
        assertEquals(draft, movie)
    }

    @Test
    fun `valori modificati e vuoti`() {
        val f = MovieForm.formFields(fields)
        val values = MovieForm.initialValues(f, draft).toMutableMap()
        values["year"] = FieldValue.Text(" 1974 ")
        values["genre"] = FieldValue.Multi(listOf("Crime", " ", "Crime"))
        values["medium"] = FieldValue.Text("Blu-ray")
        values["visto"] = FieldValue.Flag(true)
        values["director"] = FieldValue.Multi(emptyList())
        values["cast"] = FieldValue.Rows(listOf(listOf("Al Pacino", ""), listOf("", "")))
        values["tracce"] = FieldValue.Rows(listOf(listOf("1", "Intro")))
        val movie = MovieForm.toMovieJson(f, values)
        assertEquals(
            Json.parseToJsonElement(
                """{"title":"Il padrino","year":1974,"genre":["Crime"],"cast":[{"actor":"Al Pacino","role":""}],
                   "medium":"Blu-ray","visto":"true","tracce":[["1","Intro"]]}""",
            ),
            movie,
        )
    }

    @Test
    fun `validazione locale`() {
        val f = MovieForm.formFields(fields)
        val values = MovieForm.initialValues(f, JsonObject(emptyMap())).toMutableMap()
        values["year"] = FieldValue.Text("19x2")
        values["medium"] = FieldValue.Text("VHS")
        val errors = MovieForm.validate(f, values)
        assertEquals(setOf("title", "year", "medium"), errors.keys)
        values["title"] = FieldValue.Text("X"); values["year"] = FieldValue.Text("1999"); values["medium"] = FieldValue.Text("dvd")
        assertTrue(MovieForm.validate(f, values).isEmpty())
    }

    @Test
    fun `supporto senza allowed propone i default`() {
        val medium = MovieForm.formFields(listOf(Field("medium", "Supporto", "line"))).single()
        assertEquals(listOf("DVD", "Blu-ray", "4K"), medium.options)
        assertFalse(medium.restricted)
    }

    @Test
    fun `EAN`() {
        assertEquals("8012345678901", Ean.normalize(" 8012345678901 "))
        assertEquals("036000291452", Ean.normalize("0-36000-29145-2"))
        assertNull(Ean.normalize("1234567"))
        assertNull(Ean.normalize("80123456789A1"))
        assertTrue(Ean.hasValidCheckDigit("4006381333931"))
        assertTrue(Ean.hasValidCheckDigit("036000291452"))
        assertTrue(Ean.hasValidCheckDigit("96385074"))
        assertFalse(Ean.hasValidCheckDigit("4006381333932"))
    }

    @Test
    fun `UPC-E espanso in UPC-A con cifra di controllo verificata`() {
        // Esempi noti (GS1 / Wikipedia): 01234565 ↔ 012345000065, 04252614 ↔ 042100005264.
        assertEquals("012345000065", Ean.upcEToUpcA("01234565"))
        assertEquals("042100005264", Ean.upcEToUpcA("04252614"))
        // Le quattro regole di espansione (ultima cifra 0–2, 3, 4, 5–9).
        assertEquals("012000003455", Ean.upcEToUpcA("01234505"))
        assertEquals("012300000451", Ean.upcEToUpcA("01234531"))
        assertEquals("012340000053", Ean.upcEToUpcA("01234543"))
        assertEquals("012345000058", Ean.upcEToUpcA("01234558"))
        // Sistema numerico 1.
        assertEquals("112345000062", Ean.upcEToUpcA("11234562"))
        // Senza cifra di controllo (7 cifre) o senza sistema numerico (6 cifre).
        assertEquals("012345000065", Ean.upcEToUpcA("0123456"))
        assertEquals("042100005264", Ean.upcEToUpcA("425261"))
        // Ogni espansione è un UPC-A valido per l'app e per il server.
        listOf("01234565", "04252614", "01234505", "01234531", "01234543", "11234562").forEach {
            assertTrue(it, Ean.hasValidCheckDigit(Ean.upcEToUpcA(it)!!))
        }
    }

    @Test
    fun `UPC-E non valido rifiutato`() {
        assertNull(Ean.upcEToUpcA("01234566")) // cifra di controllo sbagliata
        assertNull(Ean.upcEToUpcA("21234565")) // sistema numerico 2 non esiste in UPC-E
        assertNull(Ean.upcEToUpcA("0123456A"))
        assertNull(Ean.upcEToUpcA("12345"))
        assertNull(Ean.upcEToUpcA("012345650"))
    }
}
