"""
Handles interactions with the DCS server and related files.
Includes functionality for starting/stopping the server, managing files, and more.
"""

import subprocess
import psutil
import time
import os
from typing import Tuple
from pathlib import Path
from datetime import timedelta
from app.config import Config
from app.logger import logger
import luadata


# Readiness signal. The DCS web admin port (:8088) binds during early init —
# well before the mission is actually loaded — so an HTTP probe there
# false-positives during startup. Instead, the Hooks lua script
# (resources/retribution-control.lua) writes a marker file at
# `<save_dir>/<READY_FLAG_NAME>` from `onMissionLoadEnd` and removes it on
# `onSimulationStop`. The Python side checks file existence as the readiness
# signal. setup_before_start / restore_after_stop also delete the file
# defensively so a crashed previous run doesn't leave a stale flag behind.
READY_FLAG_NAME = "ret_remote_ready.flag"

HOOKS_LUA_SOURCE = Path("resources/retribution-control.lua")
COMMENT_LINES = [
    "sanitizeModule('os')",
    "sanitizeModule('io')",
    "sanitizeModule('lfs')",
]

class DCSControl:
    """
    Singleton-like class for controlling the DCS server process and managing mission files.
    """
    process: psutil.Process = None

    @classmethod
    def initialize(cls):
        """
        Initialize and validate DCS-specific paths and other configurations.
        This method is called automatically when the module is loaded.
        """
        # Paths
        cls.mission_dir = Path(Config.get("server.dcs_mission_dir"))
        if not cls.mission_dir.exists() or not cls.mission_dir.is_dir():
            raise FileNotFoundError(f"DCS Mission directory not found at: {cls.mission_dir}")
        cls.state_json = cls.mission_dir / "state.json"
        cls.save_dir = cls.mission_dir.parent

        cls.settings_lua = cls.save_dir / "Config" / "serverSettings.lua"
        cls.settings_lua_backup = cls.settings_lua.with_suffix(".original.lua")
        cls.last_upload_txt = cls.settings_lua.parent / "retRemoteLastUpload.txt"
        if not cls.settings_lua.exists() or not cls.settings_lua.is_file():
            raise FileNotFoundError(f"serverSettings.lua not found at: {cls.settings_lua}")
        
        cls.hooks_lua = cls.save_dir / "Scripts" / "Hooks" / HOOKS_LUA_SOURCE.name
        cls.hooks_lua.parent.mkdir(parents=True, exist_ok=True)

        cls.ready_flag = cls.save_dir / READY_FLAG_NAME

        cls.dcs_server_exe = Path(Config.get("server.dcs_server_exe"))
        if not cls.dcs_server_exe.exists() or not cls.dcs_server_exe.is_file():
            raise FileNotFoundError(f"DCS_server.exe not found at: {cls.dcs_server_exe}")
        cls.install_dir = cls.dcs_server_exe.parent.parent
        
        cls.sanitize_lua = cls.install_dir / "Scripts" / "MissionScripting.lua"
        cls.sanitize_lua_backup = cls.sanitize_lua.with_suffix(".original.lua")
        if not cls.sanitize_lua.exists() or not cls.sanitize_lua.is_file():
            raise FileNotFoundError(f"MissionScripting.lua not found at: {cls.sanitize_lua}")
        
        cls.data_dir = Path("data").absolute()
        cls.state_json = cls.data_dir / "state.json"
        
        try:
            with (cls.install_dir / "variant.txt").open("r") as f:
                cls.default_folder = f"DCS.{f.read().strip()}"
        except FileNotFoundError:
            cls.default_folder = "DCS.release_server"

        logger.info(f"DCS Mission directory: {cls.mission_dir}")
        logger.info(f"DCS server executable: {cls.dcs_server_exe}")

        # Process management
        cls.max_running_time = timedelta(minutes=Config.get("server.max_running_time"))
        cls.cmd = f'Start "" /high "{cls.dcs_server_exe}" -w "{cls.save_dir.name}'

    @classmethod
    def start_process(cls):
        """
        Start the DCS server process using the executable path from the configuration.

        Returns True only when a NEW DCS server process is spawned and detected.
        Returns False if a matching process was already running at entry — the
        route layer should detect that case first and surface a 409, but we keep
        this defensive check so we never silently spawn a duplicate.
        """
        if cls.find_process():
            logger.warning(
                "DCS server is already running for this save folder; refusing to spawn duplicate."
            )
            return False

        cls.setup_before_start()
        
        # Set exporting state.json to current working directory
        cls.data_dir.mkdir(parents=True, exist_ok=True)
        data_dir = str(cls.data_dir)
        env = dict(os.environ)
        env["RETRIBUTION_EXPORT_DIR"] = data_dir
        env["LIBERATION_EXPORT_DIR"] = data_dir
        logger.debug(f"state.json export dir set to: {data_dir}")
        subprocess.Popen(cls.cmd, shell=True, env=env)
        for _ in range(20):
            if cls.find_process():
                logger.debug(f"DCS server started (PID: {cls.process.pid})")
                return True
            time.sleep(0.5)
        logger.error(
            f"DCS is still not starting after 10 seconds, failed to start!"
        )
        return False


    @classmethod
    def stop_process(cls):
        """
        Stop the DCS server process by terminating the running process.
        """
        if not cls.find_process():
            logger.warning("DCS server is not running, nothing to stop.")
            return True
        
        try:
            logger.debug("Stopping DCS server...")
            cls.process.terminate()
            cls.process.wait(timeout=15)
            logger.debug("DCS server stopped successfully.")
            cls.process = None
            cls.restore_after_stop()
            return True
        except psutil.TimeoutExpired:
            logger.error("DCS server did not stop in time, killing process...")
            cls.process.kill()
            cls.process = None
            cls.restore_after_stop()
            return False


    @classmethod
    def get_status(cls) -> timedelta:
        """
        Check if the DCS server process is fully ready (process alive AND
        the mission-load marker has been written by the Hooks lua script).
        If so, return the running time; else None.

        The marker file is what distinguishes "process spawned" from "DCS has
        finished loading the mission and players can actually connect". An
        earlier attempt used an HTTP probe to :8088/encryptedRequest, but the
        DCS web admin port binds during early init — long before the mission
        is loaded — so it false-positives.

        Returns:
            timedelta: The running time of the DCS server process, or None.
        """
        if cls.find_process() and cls._is_ready():
            return timedelta(seconds=int(time.time() - cls.process.create_time()))
        return None

    @classmethod
    def _is_ready(cls) -> bool:
        """True iff the Hooks lua script has written the mission-loaded marker."""
        return cls.ready_flag.exists()

    @classmethod
    def save_mission_file(cls, file: bytes, filename: str):
        """
        Save the uploaded mission file to the specified path.
        - Overwrites the existing mission file.
        """
        file_path = cls.mission_dir / filename
        file_path.write_bytes(file)
        logger.debug(f"Mission file saved: {file_path}")

        # Record the last uploaded file
        write_text_LF(cls.last_upload_txt, str(file_path))

    @classmethod
    def get_state_file(cls) -> Path:
        """
        Load and return the state.json path from the DCS mission directory.
        Returns:
            Path: to state.json if it exists.
        """
        if not cls.state_json.exists():
            raise FileNotFoundError(f"State file not found: {cls.state_json}")

        return cls.state_json
    
    @classmethod
    def find_process(cls) -> Tuple[psutil.Process, int]:
        # Check if the registered process running
        if cls.process and cls.process.is_running():
            return cls.process

        # Check if any process with the same save folder is running
        cls.process = None
        for proc in psutil.process_iter(["name", "cmdline"]):
            if proc.info["name"] == cls.dcs_server_exe.name:
                folder = cls.get_save_folder(proc.info["cmdline"])
                if folder == cls.save_dir.name:
                    cls.process = proc
                    return proc
        return None
    
    @classmethod
    def get_save_folder(cls, cmdline: list) -> str:
        for i, arg in enumerate(cmdline):
            if arg == "-w" and len(cmdline) > i + 1:
                return cmdline[i + 1]
        return cls.default_folder
    
    @classmethod
    def setup_before_start(cls):
        """
        Setup scripts and server settings before starting the DCS server.
        """
        # Clear any stale ready flag from a previous run that crashed before
        # the Hooks lua's onSimulationStop callback could remove it.
        if cls.ready_flag.exists():
            cls.ready_flag.unlink()
            logger.debug("Stale ready flag removed.")

        # Copy the hooks lua script to the hooks directory
        write_text_LF(cls.hooks_lua, HOOKS_LUA_SOURCE.read_text(encoding="utf-8"))
        logger.debug(f"Hooks script copied to Scripts/Hooks directory.")
        
        # Backup the original MissionScripting.lua file
        backup_path = cls.sanitize_lua_backup
        if not backup_path.exists():
            write_text_LF(backup_path, cls.sanitize_lua.read_text(encoding="utf-8"))
            logger.debug(f"MissionScripting.lua backup created at oringinal location.")

        # De-sanitize the MissionScripting.lua file
        lines = cls.sanitize_lua.read_text(encoding="utf-8").splitlines()
        sanitized_line = []
        for line in lines:
            stripped_line = line.strip()
            if stripped_line in COMMENT_LINES:
                line = f"\t-- {stripped_line}"
                logger.debug(f"MissionScripting.lua line de-sanitized: {line.strip()}")
            sanitized_line.append(line)
        write_text_LF(cls.sanitize_lua, "\n".join(sanitized_line))
        logger.debug(f"MissionScripting.lua de-sanitized successfully.")

        # Set the mission to run when the server starts
        if cls.last_upload_txt.exists():
            last_upload = Path(cls.last_upload_txt.read_text(encoding="utf-8").strip())
        else:
            last_upload = cls.mission_dir / Config.get("app.allowed_filenames")[0]

        if not last_upload.exists():
            logger.error(f"Last uploaded mission file not found: {last_upload}")
            return
        
        cfg = luadata.read(cls.settings_lua, encoding="utf-8")
        cfg["listStartIndex"] = 1
        cfg["missionList"] = [str(last_upload)]
        if "lastSelectedMission" in cfg:
            cfg['lastSelectedMission'] = str(last_upload)
        
        write_text_LF(cls.settings_lua_backup, cls.settings_lua.read_text(encoding="utf-8"))
        logger.debug(f"serverSettings.lua backup created at original location.")
        luadata.write(cls.settings_lua, cfg, encoding="utf-8", indent="    ", prefix="cfg = ")
        logger.debug(f"serverSettings.lua set to run mission: {last_upload.name}")

    @classmethod
    def restore_after_stop(cls):
        """
        Restore all files to their original state after the DCS server is stopped.
        """
        # Delete the ready flag (the Hooks lua's onSimulationStop should have
        # removed it already, but be defensive in case DCS was killed hard).
        if cls.ready_flag.exists():
            cls.ready_flag.unlink()
            logger.debug("Ready flag removed.")

        # Delete the hooks script
        if cls.hooks_lua.exists():
            cls.hooks_lua.unlink()
            logger.debug(f"Hooks script deleted.")

        # Restore the original MissionScripting.lua file
        if cls.sanitize_lua_backup.exists():
            write_text_LF(cls.sanitize_lua, cls.sanitize_lua_backup.read_text(encoding="utf-8"))
            cls.sanitize_lua_backup.unlink()
            logger.debug(f"MissionScripting.lua restored successfully.")
        else:
            logger.warning(f"MissionScripting.lua backup not found. Cannot restore.")
        
        if cls.settings_lua_backup.exists():
            write_text_LF(cls.settings_lua, cls.settings_lua_backup.read_text(encoding="utf-8"))
            cls.settings_lua_backup.unlink()
            logger.debug(f"serverSettings.lua restored successfully.")
        else:
            logger.warning(f"serverSettings.lua backup not found. Cannot restore.")


def write_text_LF(path: Path, text: str):
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)

# Automatically initialize the class when the module is loaded
try:
    DCSControl.initialize()
except (FileNotFoundError, ValueError) as e:
    logger.error(f"Error initializing DCSControl: {e}")
    input("Please check your 'config.yaml'.\nPress Enter to exit...")
    exit(1)