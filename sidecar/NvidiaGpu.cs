using System.Runtime.InteropServices;

namespace StatsReader;

/// <summary>GPU stats from NVML, the read-only monitoring library installed with the NVIDIA driver.</summary>
sealed class NvidiaGpu
{
	private const int Success = 0;
	private const uint TemperatureGpu = 0;

	private readonly IntPtr device;

	private NvidiaGpu(IntPtr device)
	{
		this.device = device;
	}

	public static NvidiaGpu? TryOpen()
	{
		try
		{
			if (nvmlInit_v2() != Success || nvmlDeviceGetHandleByIndex_v2(0, out var device) != Success)
			{
				return null;
			}
			return new NvidiaGpu(device);
		}
		catch (DllNotFoundException)
		{
			return null;
		}
	}

	public void AddTo(Dictionary<string, double> metrics)
	{
		if (nvmlDeviceGetTemperature(device, TemperatureGpu, out var temperature) == Success)
		{
			metrics["gpu_temperature"] = temperature;
		}
		if (nvmlDeviceGetUtilizationRates(device, out var usage) == Success)
		{
			metrics["gpu_usage"] = usage.Gpu;
		}
		if (nvmlDeviceGetMemoryInfo(device, out var memory) == Success && memory.Total > 0)
		{
			metrics["memory_usage"] = 100.0 * memory.Used / memory.Total;
		}
		if (nvmlDeviceGetPowerUsage(device, out var milliwatts) == Success)
		{
			metrics["power"] = milliwatts / 1000.0;
		}
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct Utilization
	{
		public uint Gpu;
		public uint Memory;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct MemoryInfo
	{
		public ulong Total;
		public ulong Free;
		public ulong Used;
	}

	[DllImport("nvml.dll")] private static extern int nvmlInit_v2();
	[DllImport("nvml.dll")] private static extern int nvmlDeviceGetHandleByIndex_v2(uint index, out IntPtr device);
	[DllImport("nvml.dll")] private static extern int nvmlDeviceGetTemperature(IntPtr device, uint sensor, out uint celsius);
	[DllImport("nvml.dll")] private static extern int nvmlDeviceGetUtilizationRates(IntPtr device, out Utilization usage);
	[DllImport("nvml.dll")] private static extern int nvmlDeviceGetMemoryInfo(IntPtr device, out MemoryInfo memory);
	[DllImport("nvml.dll")] private static extern int nvmlDeviceGetPowerUsage(IntPtr device, out uint milliwatts);
}
