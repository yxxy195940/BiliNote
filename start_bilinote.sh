#!/bin/bash

# ==========================================
# BiliNote 一键启动脚本 (WSL2 版)
# ==========================================

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 正在启动 BiliNote 全家桶...${NC}"

# 1. 检查并清理旧进程
echo -e "${YELLOW}清理端口占用 (8483, 3015)...${NC}"
sudo fuser -k 8483/tcp > /dev/null 2>&1
sudo fuser -k 3015/tcp > /dev/null 2>&1

# 2. 启动 Ollama (本地大模型服务)
if ! pgrep -x "ollama" > /dev/null; then
    echo -e "${YELLOW}启动 Ollama 服务...${NC}"
    nohup ollama serve > ollama.log 2>&1 &
    sleep 3
else
    echo -e "${GREEN}✅ Ollama 已在运行${NC}"
fi

# 3. 启动后端 (FastAPI)
echo -e "${YELLOW}启动后端服务 (端口 8483)...${NC}"
cd backend
# 确保使用正确的虚拟环境
nohup ./myvenv/bin/python main.py > backend_run.log 2>&1 &
cd ..

# 4. 启动前端 (Vite)
echo -e "${YELLOW}启动前端服务 (端口 3015)...${NC}"
cd BillNote_frontend
# 使用 --host 确保 Windows 可以顺利访问 WSL2 端口
nohup npx vite --port 3015 --host > frontend_run.log 2>&1 &
cd ..

# 5. 等待并检查状态
echo -e "${BLUE}⏳ 等待服务初始化...${NC}"
sleep 5

# 检查后端
if curl -s http://localhost:8483/api/sys_health | grep -q "success"; then
    echo -e "${GREEN}✅ 后端启动成功: http://localhost:8483${NC}"
else
    echo -e "${RED}❌ 后端启动可能存在问题，请检查 backend/backend_run.log${NC}"
fi

# 检查前端
if curl -sI http://localhost:3015 | grep -q "HTTP/1.1 200"; then
    echo -e "${GREEN}✅ 前端启动成功: http://localhost:3015${NC}"
else
    echo -e "${RED}❌ 前端启动可能存在问题，请检查 BillNote_frontend/frontend_run.log${NC}"
fi

echo -e "\n${BLUE}==========================================${NC}"
echo -e "${GREEN}🎉 所有服务已在后台运行！${NC}"
echo -e "${BLUE}👉 请在浏览器访问: http://localhost:3015${NC}"
echo -e "${BLUE}==========================================${NC}"
echo -e "提示: 如需停止服务，可执行: sudo fuser -k 8483/tcp 3015/tcp"
