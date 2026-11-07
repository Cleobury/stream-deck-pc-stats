using System.Diagnostics;
using System.Net;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using StatsReader;

const int DefaultPort = 9696;
const int SampleIntervalMs = 1000;

var port = args.Length == 2 && args[0] == "--port" && int.TryParse(args[1], out var parsedPort) ? parsedPort : DefaultPort;
var isElevated = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

// The login task and the plugin can both start a reader. Only an elevated reader has CPU sensors, so it
// replaces a plain one; a plain reader steps aside for any reader already running.
if (port == DefaultPort)
{
	foreach (var other in Process.GetProcessesByName("StatsReader").Where(process => process.Id != Environment.ProcessId))
	{
		if (!isElevated)
		{
			return;
		}
		other.Kill();
		other.WaitForExit(3000);
	}
}

using var listener = new HttpListener();
listener.Prefixes.Add($"http://localhost:{port}/");
listener.Start();

using var frames = new FrameTracker();
var gpu = NvidiaGpu.TryOpen();
using var cpuSensors = isElevated ? CpuSensors.TryOpen() : null;
var system = new SystemStats();

var notes = new List<string>();
if (gpu is null)
{
	notes.Add("NVIDIA GPU stats unavailable");
}
if (cpuSensors is null)
{
	notes.Add(isElevated ? "CPU sensors unavailable: PawnIO driver not found" : "CPU temperature and power need install-startup.ps1");
}

var responseBody = Array.Empty<byte>();

var sampler = new Thread(() =>
{
	while (true)
	{
		var metrics = new Dictionary<string, double>();
		system.AddTo(metrics);
		gpu?.AddTo(metrics);
		cpuSensors?.AddTo(metrics);
		frames.AddTo(metrics);

		Volatile.Write(ref responseBody, JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object?>
		{
			["timestampUtc"] = DateTimeOffset.UtcNow,
			["status"] = "ok",
			["metrics"] = metrics,
			["notes"] = notes,
			["error"] = null,
		}));
		Thread.Sleep(SampleIntervalMs);
	}
}) { IsBackground = true };
sampler.Start();

while (true)
{
	var context = await listener.GetContextAsync();
	using var response = context.Response;
	if (context.Request.Url?.AbsolutePath.TrimEnd('/') != "/metrics")
	{
		response.StatusCode = 404;
		continue;
	}
	var body = Volatile.Read(ref responseBody);
	if (body.Length == 0)
	{
		body = Encoding.UTF8.GetBytes("""{"status":"starting","metrics":{},"error":null}""");
	}
	response.ContentType = "application/json";
	await response.OutputStream.WriteAsync(body);
}
