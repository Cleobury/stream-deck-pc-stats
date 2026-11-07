using System.Runtime.InteropServices;

namespace StatsReader;

/// <summary>CPU load and RAM use, read from Windows.</summary>
sealed class SystemStats
{
	private ulong previousIdle;
	private ulong previousTotal;

	public void AddTo(Dictionary<string, double> metrics)
	{
		if (GetSystemTimes(out var idle, out var kernel, out var user))
		{
			// Kernel time includes idle time.
			var idleTicks = idle.Ticks;
			var totalTicks = kernel.Ticks + user.Ticks;
			if (previousTotal != 0 && totalTicks > previousTotal)
			{
				var busyFraction = 1.0 - (double)(idleTicks - previousIdle) / (totalTicks - previousTotal);
				metrics["cpu_usage"] = Math.Clamp(busyFraction, 0, 1) * 100;
			}
			previousIdle = idleTicks;
			previousTotal = totalTicks;
		}

		var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
		if (GlobalMemoryStatusEx(ref memory) && memory.TotalPhysical > 0)
		{
			metrics["ram_usage"] = 100.0 * (memory.TotalPhysical - memory.AvailablePhysical) / memory.TotalPhysical;
		}
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct FileTime
	{
		public uint Low;
		public uint High;
		public readonly ulong Ticks => ((ulong)High << 32) | Low;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct MemoryStatus
	{
		public uint Length;
		public uint MemoryLoad;
		public ulong TotalPhysical;
		public ulong AvailablePhysical;
		public ulong TotalPageFile;
		public ulong AvailablePageFile;
		public ulong TotalVirtual;
		public ulong AvailableVirtual;
		public ulong AvailableExtendedVirtual;
	}

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
}
