using LibreHardwareMonitor.Hardware;

namespace StatsReader;

/// <summary>CPU temperature. Reading it needs an elevated process and the PawnIO driver.</summary>
sealed class CpuSensors : IDisposable
{
	private readonly Computer computer;
	private readonly IHardware cpu;

	private CpuSensors(Computer computer, IHardware cpu)
	{
		this.computer = computer;
		this.cpu = cpu;
	}

	public static CpuSensors? TryOpen()
	{
		// Only the CPU is enabled, so this library never touches the GPU.
		var computer = new Computer { IsCpuEnabled = true };
		try
		{
			computer.Open();
			var cpu = computer.Hardware.FirstOrDefault(hardware => hardware.HardwareType == HardwareType.Cpu);
			if (cpu is not null)
			{
				cpu.Update();
				if (FindTemperature(cpu) is not null)
				{
					return new CpuSensors(computer, cpu);
				}
			}
		}
		catch (Exception)
		{
			// A missing driver surfaces as different exceptions depending on the CPU; all mean "no sensors".
		}
		computer.Close();
		return null;
	}

	public void AddTo(Dictionary<string, double> metrics)
	{
		cpu.Update();
		if (FindTemperature(cpu)?.Value is { } temperature)
		{
			metrics["cpu_temperature"] = temperature;
		}
		// Only a fallback: CpuPower reads this without admin rights where Windows supports it.
		var power = cpu.Sensors.FirstOrDefault(sensor => sensor is { SensorType: SensorType.Power, Name: "Package" });
		if (power?.Value is { } watts)
		{
			metrics.TryAdd("cpu_power", watts);
		}
	}

	public void Dispose() => computer.Close();

	private static ISensor? FindTemperature(IHardware cpu)
	{
		var temperatures = cpu.Sensors.Where(sensor => sensor.SensorType == SensorType.Temperature && sensor.Value is not null).ToList();
		return temperatures.FirstOrDefault(sensor => sensor.Name == "Core (Tctl/Tdie)")
			?? temperatures.FirstOrDefault(sensor => sensor.Name == "CPU Package")
			?? temperatures.FirstOrDefault();
	}
}
