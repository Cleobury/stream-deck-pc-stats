using System.Diagnostics;

namespace StatsReader;

/// <summary>CPU package power from the Windows Energy Meter counter, which needs no admin rights.</summary>
sealed class CpuPower
{
	private const string Category = "Energy Meter";
	private const string CounterName = "Power";
	private const string PackageInstanceSuffix = "_pkg";
	private const double MilliwattsPerWatt = 1000;

	private readonly PerformanceCounter counter;

	private CpuPower(PerformanceCounter counter)
	{
		this.counter = counter;
	}

	public static CpuPower? TryOpen()
	{
		try
		{
			var instance = new PerformanceCounterCategory(Category).GetInstanceNames()
				.FirstOrDefault(name => name.EndsWith(PackageInstanceSuffix, StringComparison.OrdinalIgnoreCase));
			return instance is null ? null : new CpuPower(new PerformanceCounter(Category, CounterName, instance, readOnly: true));
		}
		catch (Exception exception) when (exception is InvalidOperationException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
		{
			return null;
		}
	}

	public void AddTo(Dictionary<string, double> metrics)
	{
		try
		{
			var milliwatts = counter.NextValue();
			if (milliwatts > 0)
			{
				metrics["cpu_power"] = milliwatts / MilliwattsPerWatt;
			}
		}
		catch (InvalidOperationException)
		{
			// The tile keeps its last value until the counter comes back.
		}
	}
}
