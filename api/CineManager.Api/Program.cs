using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Endpoints;
using CineManager.Api.Devices;
using CineManager.Api.Import;
using CineManager.Api.Infrastructure;
using CineManager.Api.Lookup;
using CineManager.Api.Movies;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Cinema");
if (string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException("ConnectionStrings__Cinema mancante.");

builder.Services.AddDbContext<CinemaDbContext>(o => o.UseNpgsql(connectionString));
builder.Services.AddMemoryCache();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddProblemDetails();
builder.Services.Configure<CoversOptions>(builder.Configuration.GetSection(CoversOptions.Section));
builder.Services.Configure<TellicoOptions>(builder.Configuration.GetSection(TellicoOptions.Section));
builder.Services.AddScoped<CoverStore>();
builder.Services.AddScoped<TellicoImporter>();

// Fase 3: app Android, ricerca EAN/TMDb, arrivi (§4.2, §6.3, §7).
builder.Services.Configure<AppOptions>(builder.Configuration.GetSection(AppOptions.Section));
builder.Services.Configure<LookupOptions>(builder.Configuration.GetSection(LookupOptions.Section));
builder.Services.Configure<TmdbOptions>(builder.Configuration.GetSection(TmdbOptions.Section));
builder.Services.AddSingleton<AppVersionProvider>();
builder.Services.AddHttpClient(AppVersionProvider.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(3));
builder.Services.AddHttpClient<TmdbClient>(c => c.Timeout = TimeSpan.FromSeconds(10));
builder.Services.AddHttpClient<UpcItemDbProvider>(c => c.Timeout = TimeSpan.FromSeconds(10));
builder.Services.AddScoped<IBarcodeProvider>(sp => sp.GetRequiredService<UpcItemDbProvider>());
// Copertine solo da image.tmdb.org e senza redirect automatici: un redirect porterebbe fuori dall'host (§7).
builder.Services.AddHttpClient<CoverDownloader>(c => c.Timeout = TimeSpan.FromSeconds(20))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
builder.Services.AddScoped<BarcodeLookupService>();
builder.Services.AddScoped<MovieLookupService>();
builder.Services.AddScoped<ArrivalService>();

// Corpo massimo di default 1 MB; gli import alzano il limite con [RequestSizeLimit].
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 1024 * 1024);

if (!builder.Environment.IsDevelopment())
{
    if (string.IsNullOrWhiteSpace(builder.Configuration["Covers:Path"]))
        throw new InvalidOperationException("Covers__Path mancante.");
}

builder.AddCineForwardedHeaders();
builder.AddCineDataProtection();
builder.AddCineRateLimiter();
builder.AddCineAuth();

var app = builder.Build();

// Migrazioni all'avvio: c'è una sola istanza dell'API.
using (var scope = app.Services.CreateScope())
    await scope.ServiceProvider.GetRequiredService<CinemaDbContext>().Database.MigrateAsync();

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseRateLimiter();
app.UseMiddleware<CsrfMiddleware>();
app.UseAuthentication();
app.UseAuthorization();

app.MapAuthEndpoints();
app.MapCollectionEndpoints();
app.MapStateEndpoints();
app.MapImportEndpoints();
app.MapPairingEndpoints();
app.MapDeviceEndpoints();
app.MapAppEndpoints();
app.MapArrivalEndpoints();
app.MapFieldEndpoints();

app.Run();

public partial class Program;
