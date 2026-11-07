using System.Runtime.InteropServices;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Session;

namespace StatsReader;

/// <summary>
/// Measures the foreground app's frame rate from the frame events Windows' graphics stack publishes,
/// so nothing is injected into the game.
/// </summary>
sealed class FrameTracker : IDisposable
{
	private const string SessionName = "StreamDeckStatsReader";
	private const int PresentStartEventId = 42;
	private const ulong PresentKeywords = 0x8000000000000001;
	private static readonly Guid DxgiProvider = new("CA11C036-0102-4A2D-A6AD-F03CFED5D3C9");
	private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(10);
	private const double LiveWindowMs = 1000;
	private const double HistoryWindowMs = 30_000;

	private readonly Dictionary<int, Queue<Frame>> framesByProcess = [];
	private readonly Lock framesLock = new();
	private volatile TraceEventSession? session;
	private volatile bool disposed;
	private double latestEventMs;
	private long latestEventAtTick;

	public FrameTracker()
	{
		new Thread(Run) { IsBackground = true }.Start();
	}

	public void AddTo(Dictionary<string, double> metrics)
	{
		var stats = ReadForeground();
		metrics["framerate"] = stats.Fps;
		metrics["framerate_1_low"] = stats.OnePercentLowFps;
	}

	private FrameStats ReadForeground()
	{
		GetWindowThreadProcessId(GetForegroundWindow(), out var foregroundProcessId);

		lock (framesLock)
		{
			// Event times only advance while frames arrive, so age them against the clock.
			var nowMs = latestEventMs + (Environment.TickCount64 - latestEventAtTick);
			Prune(nowMs);
			if (!framesByProcess.TryGetValue((int)foregroundProcessId, out var history))
			{
				return default;
			}

			var liveFrames = history.Where(frame => nowMs - frame.AtMs <= LiveWindowMs).ToList();
			if (liveFrames.Count == 0)
			{
				return default;
			}

			var slowestFirst = history.Select(frame => frame.Milliseconds).OrderDescending().ToList();
			var slowestPercent = slowestFirst.Take(Math.Max(1, slowestFirst.Count / 100)).Average();
			return new FrameStats(1000 / liveFrames.Average(frame => frame.Milliseconds), 1000 / slowestPercent);
		}
	}

	private void Prune(double nowMs)
	{
		foreach (var (processId, frames) in framesByProcess.ToList())
		{
			while (frames.Count > 0 && nowMs - frames.Peek().AtMs > HistoryWindowMs)
			{
				frames.Dequeue();
			}
			if (frames.Count == 0)
			{
				framesByProcess.Remove(processId);
			}
		}
	}

	private void Run()
	{
		var lastPresentByProcess = new Dictionary<int, double>();

		while (!disposed)
		{
			try
			{
				using var trace = new TraceEventSession(SessionName) { StopOnDispose = true };
				session = trace;
				trace.EnableProvider(DxgiProvider, TraceEventLevel.Informational, PresentKeywords);
				trace.Source.AllEvents += data =>
				{
					if ((int)data.ID == PresentStartEventId)
					{
						Record(data.ProcessID, data.TimeStampRelativeMSec, lastPresentByProcess);
					}
				};
				trace.Source.Process();
			}
			catch (Exception exception) when (exception is UnauthorizedAccessException or COMException or InvalidOperationException)
			{
				// Keep retrying: the tiles show 0 FPS until capture comes back.
			}
			lastPresentByProcess.Clear();
			if (!disposed)
			{
				Thread.Sleep(RetryDelay);
			}
		}
	}

	private void Record(int processId, double atMs, Dictionary<int, double> lastPresentByProcess)
	{
		if (!lastPresentByProcess.TryGetValue(processId, out var previousMs))
		{
			lastPresentByProcess[processId] = atMs;
			return;
		}
		lastPresentByProcess[processId] = atMs;

		lock (framesLock)
		{
			if (!framesByProcess.TryGetValue(processId, out var frames))
			{
				framesByProcess[processId] = frames = new Queue<Frame>();
			}
			frames.Enqueue(new Frame(atMs, atMs - previousMs));
			latestEventMs = atMs;
			latestEventAtTick = Environment.TickCount64;
		}
	}

	public void Dispose()
	{
		disposed = true;
		session?.Dispose();
	}

	private readonly record struct Frame(double AtMs, double Milliseconds);

	private readonly record struct FrameStats(double Fps, double OnePercentLowFps);

	[DllImport("user32.dll")]
	private static extern IntPtr GetForegroundWindow();

	[DllImport("user32.dll")]
	private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
