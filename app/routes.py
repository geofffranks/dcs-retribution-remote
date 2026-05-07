"""
Handles all web and API routes for the application.
Includes endpoints for uploading files, starting/stopping the DCS server, and more.
"""

from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from app.auth import get_current_user
from app.control import DCSControl
from app.config import Config
from app.logger import logger


allowed_filenames: list = Config.get("app.allowed_filenames")
allowed_max_size: int = Config.get("app.allowed_max_size")
state_json = DCSControl.state_json
logger.info(f"state.json will be saved at: {state_json}")

index_html = HTMLResponse(
    Path("app/templates/index.html").read_text(encoding="utf-8"),
    media_type="text/html"
)

router_spa = APIRouter()
router_api_v1 = APIRouter(prefix="/api/v1")

# Serve the SPA entry point
@router_spa.get("/", response_class=HTMLResponse)
async def serve_spa():
    """
    Serve the main SPA entry point (index.html).
    """
    return index_html

# API endpoints under /api/v1
@router_api_v1.get("/auth/validate", response_model=dict)
async def validate_auth(user=Depends(get_current_user)):
    """
    Validate the authentication header.
    Returns the authenticated user's information if valid.
    """
    return {"message": "Authentication valid", "user": user}

@router_api_v1.post("/server/start", response_model=dict)
async def start_server(user=Depends(get_current_user)):
    """
    Start the DCS server process.
    """
    if DCSControl.find_process():
        raise HTTPException(
            status_code=409,
            detail="A DCS server is already running with this save folder. Stop it first.",
        )

    if DCSControl.start_process():
        logger.info(f"'{user}' started DCS server")
        return {"message": "DCS server started successfully"}

    raise HTTPException(
        status_code=500,
        detail="DCS server did not appear within 10 seconds after spawn. Check the dedicated server logs.",
    )

@router_api_v1.post("/server/stop", response_model=dict)
async def stop_server(user=Depends(get_current_user)):
    """
    Stop the DCS server process.
    """
    if DCSControl.stop_process():
        logger.info(f"'{user}' stopped DCS server")
        return {"message": "DCS server stopped successfully"}
    
    raise HTTPException(status_code=500, detail="Failed to stop DCS server")

@router_api_v1.get("/status", response_model=dict)
async def server_status(user=Depends(get_current_user)):
    """
    Get the current status of the DCS server and this application.
    """
    status = DCSControl.get_status()
    return {
        "status": "running" if status else "stopped",
        "uptime": str(status) if status else "N/A",
        "allowed_filenames": allowed_filenames,
        "allowed_max_size": allowed_max_size,
    }

@router_api_v1.post("/files/upload_miz", response_model=dict)
async def upload_file(file: UploadFile, user=Depends(get_current_user)):
    """
    Upload a mission file to the server.
    """
    # Validate file name
    if file.filename not in allowed_filenames:
        raise HTTPException(status_code=400, detail=f"Invalid file name: {file.filename}")

    # Save the file
    try:
        DCSControl.save_mission_file(await file.read(), file.filename)
        logger.info(f"'{user}' uploaded '{file.filename}'")
        return {"message": f"File '{file.filename}' uploaded successfully"}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to save file.\nIs the current mission file being used?")

@router_api_v1.get("/files/state.json", response_class=FileResponse)
async def download_state_file(user=Depends(get_current_user)):
    """
    Download the `state.json` file from the server.
    """
    if not state_json.exists():
        raise HTTPException(status_code=404, detail="state.json file not found")

    return FileResponse(state_json, media_type="application/json", filename="state.json")
