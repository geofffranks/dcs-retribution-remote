if RetCtrl then return end

RetCtrl = {}

-- Path of the readiness marker file. retribution_remote checks for this
-- file's existence to decide whether the DCS server is fully up. Written
-- on mission load, removed on simulation stop. lfs.writedir() returns the
-- Saved Games dir, which retribution_remote derives the same way (it's
-- save_dir = mission_dir.parent in app/control.py).
local READY_FLAG_PATH = lfs.writedir() .. "ret_remote_ready.flag"

local function write_ready_flag()
    local f, err = io.open(READY_FLAG_PATH, "w")
    if f then
        f:write(tostring(os.time()))
        f:close()
        log.info("Retribution Remote: ready flag written at " .. READY_FLAG_PATH)
    else
        log.error("Retribution Remote: could not write ready flag: " .. tostring(err))
    end
end

local function remove_ready_flag()
    os.remove(READY_FLAG_PATH)
    log.info("Retribution Remote: ready flag removed")
end

---Chat commands to control the server
---@param playerID integer
---@param message string
---@param all boolean
function RetCtrl.onPlayerTrySendChat(playerID, message, all)
    if message:sub(1, 1) ~= "/" then return end

    message = message:lower()
    if message == "/resume" then
        DCS.setPause(false)
    elseif message == "/pause" then
        DCS.setPause(true)
    end
end

---Mission has finished loading. Mark the server as ready so retribution_remote
---flips /api/v1/status from "stopped" to "running".
function RetCtrl.onMissionLoadEnd()
    write_ready_flag()
end

---Simulation is stopping (stop button, mission end, server quit). Clear the
---ready flag so /api/v1/status reverts to "stopped".
function RetCtrl.onSimulationStop()
    remove_ready_flag()
end

DCS.setUserCallbacks(RetCtrl)
log.info("Retribution Remote Control Script loaded")