package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.api.ApiException
import io.github.mcauzzi.cinemanager.core.api.CineManagerApi
import io.github.mcauzzi.cinemanager.core.api.DeviceCredentials
import io.github.mcauzzi.cinemanager.core.crash.CrashEnvironment
import io.github.mcauzzi.cinemanager.core.crash.CrashQueue
import io.github.mcauzzi.cinemanager.core.crash.CrashReport
import io.github.mcauzzi.cinemanager.core.crash.CrashUploader
import io.github.mcauzzi.cinemanager.core.pairing.ServerUrls
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class CrashReportingTest {
    @get:Rule val tmp = TemporaryFolder()

    private val env = CrashEnvironment(10300, "1.3.0", "OnePlus CPH2653", "15 (SDK 35)")
    private var now = 1_000_000_000_000L
    private fun queue(dir: File = tmp.root, maxFiles: Int = 20) = CrashQueue(dir, maxFiles = maxFiles, clock = { now })
    private fun report(msg: String = "boom") =
        CrashReport.fromThrowable(IllegalStateException(msg), "main", "2026-11-01T17:50:44Z", env)

    @Test
    fun `fromThrowable con cause e stack troncato`() {
        val r = CrashReport.fromThrowable(RuntimeException("fuori", IOException("dentro")), "main", "t", env)
        assertEquals("crash", r.kind)
        assertEquals("java.lang.RuntimeException", r.exception)
        assertEquals("fuori", r.message)
        assertTrue(r.stackTrace!!.contains("Caused by: java.io.IOException: dentro"))
        assertEquals(10300, r.appVersionCode)

        val deep = RuntimeException("x").apply { stackTrace = Array(5000) { StackTraceElement("C$it", "m", "F.kt", it) } }
        val t = CrashReport.fromThrowable(deep, "main", "t", env).stackTrace!!
        assertTrue(t.length <= CrashReport.STACK_MAX + 20)
        assertTrue(t.endsWith("[troncato]"))
    }

    @Test
    fun `coda - salva, rilegge in ordine, scarta illeggibili e scadute`() {
        val q = queue()
        assertTrue(q.save(report("primo")))
        now += 1000
        assertTrue(q.save(report("secondo")))
        File(tmp.root, "crash-000000000000001-rotto000.json").writeText("{non json")
        assertEquals(listOf("primo", "secondo"), q.pending().map { it.report.message })
        assertEquals(2, tmp.root.listFiles()!!.count { it.name.endsWith(".json") })

        now += 31L * 24 * 3600 * 1000
        assertTrue(q.pending().isEmpty())
    }

    @Test
    fun `coda - tiene solo le piu recenti`() {
        val q = queue(maxFiles = 3)
        repeat(5) { i -> q.save(report("n$i")); now += 1 }
        assertEquals(listOf("n2", "n3", "n4"), q.pending().map { it.report.message })
    }

    @Test
    fun `coda - save non lancia se la cartella non e scrivibile`() {
        val file = tmp.newFile("non-una-cartella")
        assertFalse(queue(File(file, "sotto")).save(report()))
    }

    @Test
    fun `uploader - lotti da 10, cancella solo dopo la conferma`() = runBlocking {
        val q = queue()
        repeat(12) { q.save(report("n$it")); now += 1 }
        val batches = mutableListOf<Int>()
        val sent = CrashUploader(q) { batches += it.size }.upload()
        assertEquals(12, sent)
        assertEquals(listOf(10, 2), batches)
        assertTrue(q.pending().isEmpty())
    }

    @Test
    fun `uploader - rete o 5xx lasciano la coda, 400 scarta il lotto`() = runBlocking {
        val q = queue()
        repeat(3) { q.save(report("n$it")); now += 1 }
        assertEquals(0, CrashUploader(q) { throw ApiException.Network(IOException("giù")) }.upload())
        assertEquals(0, CrashUploader(q) { throw ApiException.Server(503, null) }.upload())
        assertEquals(3, q.pending().size)

        assertEquals(0, CrashUploader(q) { throw ApiException.Validation(emptyMap(), "no") }.upload())
        assertTrue(q.pending().isEmpty())
    }

    @Test
    fun `uploader - rispetta il limite di byte del lotto`() = runBlocking {
        val q = queue()
        repeat(4) { q.save(report("x".repeat(1500))); now += 1 }
        val batches = mutableListOf<Int>()
        CrashUploader(q, maxBatchBytes = 4000) { batches += it.size }.upload()
        assertEquals(4, batches.sum())
        assertTrue(batches.all { it <= 2 })
    }

    @Test
    fun `uploader - il limite del lotto conta i byte UTF-8, non i caratteri`() = runBlocking {
        val q = queue()
        // 1500 caratteri da 3 byte ciascuno: contati come caratteri due report starebbero in 4000.
        repeat(4) { q.save(report("€".repeat(1500))); now += 1 }
        val batches = mutableListOf<Int>()
        CrashUploader(q, maxBatchBytes = 4000) { batches += it.size }.upload()
        assertEquals(4, batches.sum())
        assertTrue(batches.all { it == 1 })
    }

    @Test
    fun `client - POST firmato su app crash con il lotto`() = runBlocking<Unit> {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(204))
            val key = TestKeys.random()
            val api = CineManagerApi(ServerUrls.trusted(server.url("/api").toString()), CineManagerApi.defaultClient(),
                DeviceCredentials("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", key), 10300)
            api.sendCrashReports(listOf(report()))

            val rec = server.takeRequest()
            assertEquals("POST", rec.method)
            assertEquals("/api/app/crash", rec.path)
            val body = rec.body.readByteArray()
            assertNotNull(ServerRules.verify(rec.getHeader("Authorization")!!.removePrefix("CM-Device "), key.publicKeySpki,
                rec.method!!, rec.path!!, body, System.currentTimeMillis() / 1000))
            val reports = (Json.parseToJsonElement(body.decodeToString()) as JsonObject)["reports"] as JsonArray
            val first = reports.single() as JsonObject
            assertEquals("crash", first["kind"]!!.jsonPrimitive.content)
            assertEquals("java.lang.IllegalStateException", first["exception"]!!.jsonPrimitive.content)
        } finally {
            server.shutdown()
        }
    }
}
