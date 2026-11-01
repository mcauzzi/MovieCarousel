using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using CineManager.Api.Devices;
using CineManager.Api.Tests.Support;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace CineManager.Api.Tests;

/// <summary>Log catturati in memoria, con gli scope attivi al momento della scrittura.</summary>
public sealed class CapturingLoggerProvider : ILoggerProvider
{
    public sealed record Entry(string Category, LogLevel Level, string Message,
        IReadOnlyDictionary<string, object?> State, IReadOnlyDictionary<string, object?> Scope);

    public ConcurrentQueue<Entry> Entries { get; } = new();
    private readonly AsyncLocal<ImmutableStack> _scopes = new();

    private sealed record ImmutableStack(IReadOnlyDictionary<string, object?> Top, ImmutableStack? Next);

    public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);
    public void Dispose() { }

    private static IReadOnlyDictionary<string, object?> ToDict(object? state) =>
        state is IEnumerable<KeyValuePair<string, object?>> kv ? kv.ToDictionary(p => p.Key, p => p.Value) : new Dictionary<string, object?>();

    private sealed class Logger(CapturingLoggerProvider p, string category) : ILogger
    {
        public IDisposable BeginScope<TState>(TState state) where TState : notnull
        {
            var prev = p._scopes.Value;
            p._scopes.Value = new ImmutableStack(ToDict(state), prev);
            return new Pop(() => p._scopes.Value = prev);
        }

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var scope = new Dictionary<string, object?>();
            for (var s = p._scopes.Value; s is not null; s = s.Next)
                foreach (var (k, v) in s.Top) scope.TryAdd(k, v);
            p.Entries.Enqueue(new Entry(category, logLevel, formatter(state, exception), ToDict(state), scope));
        }
    }

    private sealed class Pop(Action a) : IDisposable { public void Dispose() => a(); }
}

/// <summary><c>POST /api/app/crash</c>: segnalazioni di crash dell'app → log, niente DB.</summary>
public class CrashReportTests : IDisposable
{
    private sealed class LogFactory(CapturingLoggerProvider logs) : AppFactory
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.ConfigureLogging(l => l.AddProvider(logs));
        }
    }

    private readonly CapturingLoggerProvider _logs = new();
    private readonly AppFactory? _f;

    public CrashReportTests()
    {
        if (TestDb.BaseConnection is null) return;
        _f = new LogFactory(_logs);
    }

    private List<CapturingLoggerProvider.Entry> Crashes() =>
        _logs.Entries.Where(e => e.Category == CrashReports.LogCategory).ToList();

    private async Task<HttpResponseMessage> Send(TestDevice dev, object body)
    {
        using var c = _f!.AppClient();
        return await c.SendAsync(dev.Request(HttpMethod.Post, "/api/app/crash", JsonSerializer.Serialize(body)));
    }

    [DbFact]
    public async Task Segnalazioni_valide_204_e_un_log_Error_per_ognuna()
    {
        using var dev = await _f!.PairAsync("alice", "Telefono");
        var res = await Send(dev, new
        {
            reports = new object[]
            {
                new
                {
                    kind = "crash", occurredAt = "2026-11-01T17:50:44Z", appVersionCode = 10300, appVersion = "1.3.0",
                    device = "OnePlus CPH2653", android = "15 (SDK 35)", thread = "main",
                    exception = "java.util.concurrent.RejectedExecutionException", message = "Task rejected",
                    stackTrace = "java.util.concurrent.RejectedExecutionException: Task rejected\n\tat a.b(C.kt:1)",
                },
                new { kind = "ANR", exception = "ANR", message = "Input dispatching timed out" },
            },
        });
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        var logs = Crashes();
        Assert.Equal(2, logs.Count);
        Assert.All(logs, l => Assert.Equal(LogLevel.Error, l.Level));
        var first = logs[0];
        Assert.Equal("crash", first.State["Kind"]);
        Assert.Equal(dev.Id.ToString(), first.State["Device"]);
        Assert.Equal("alice", first.State["Sub"]);
        Assert.Equal(10300, first.State["AppVersionCode"]);
        Assert.Equal("java.util.concurrent.RejectedExecutionException", first.State["ExceptionType"]);
        Assert.Contains("at a.b(C.kt:1)", first.Message);
        Assert.Equal("OnePlus CPH2653", first.Scope["DeviceModel"]);
        Assert.Equal("Telefono", first.Scope["DeviceName"]);
        Assert.Equal("anr", logs[1].State["Kind"]);
    }

    [DbFact]
    public async Task Tipo_sconosciuto_diventa_other_e_testi_lunghi_troncati()
    {
        using var dev = await _f!.PairAsync();
        var res = await Send(dev, new
        {
            reports = new[] { new { kind = "boh", exception = "X\0Y", stackTrace = new string('s', 100 * 1024) } },
        });
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        var log = Assert.Single(Crashes());
        Assert.Equal("other", log.State["Kind"]);
        Assert.Equal("XY", log.State["ExceptionType"]);
        var stack = (string)log.State["StackTrace"]!;
        Assert.True(stack.Length < 70 * 1024);
        Assert.EndsWith("[troncato]", stack);
    }

    [DbTheory]
    [InlineData("{}")]
    [InlineData("""{"reports":[]}""")]
    [InlineData("""{"reports":[null]}""")]
    [InlineData("""{"reports":[{},{},{},{},{},{},{},{},{},{},{}]}""")]
    public async Task Lotto_vuoto_nullo_o_oltre_10_400(string json)
    {
        using var dev = await _f!.PairAsync();
        using var c = _f.AppClient();
        var res = await c.SendAsync(dev.Request(HttpMethod.Post, "/api/app/crash", json));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Empty(Crashes());
    }

    [DbFact]
    public async Task Senza_firma_401_e_nessun_log()
    {
        using var c = _f!.AppClient();
        var res = await c.PostAsync("/api/app/crash",
            new StringContent("""{"reports":[{"kind":"crash"}]}""", System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Empty(Crashes());
    }

    public void Dispose() => _f?.Dispose();
}
